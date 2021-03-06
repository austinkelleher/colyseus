import * as http from 'http';
import * as net from 'net';
import * as msgpack from 'notepack.io';
import * as parseURL from 'url-parse';
import * as WebSocket from 'ws';
import { ServerOptions as IServerOptions } from 'ws';

import { debugError } from './Debug';
import { MatchMaker } from './MatchMaker';
import { RegisteredHandler } from './matchmaker/RegisteredHandler';
import { Presence } from './presence/Presence';

import { Client, generateId, isValidId } from './index';
import { decode, Protocol, send } from './Protocol';
import { Room, RoomConstructor } from './Room';
import { parseQueryString, registerGracefulShutdown } from './Utils';

const PING_INTERVAL = 1 * 1000; // 1 seconds for verifying ping.
function noop() {/* tslint:disable:no-empty */}
function heartbeat() { this.pingCount = 0; }

export type ServerOptions = IServerOptions & {
  verifyClient?: WebSocket.VerifyClientCallbackAsync
  presence?: any,
  engine?: any,
  ws?: any,
};

export class Server {
  public matchMaker: MatchMaker;

  protected server: WebSocket.Server;
  protected httpServer: net.Server | http.Server;

  protected presence: Presence;
  protected pingInterval: NodeJS.Timer;

  protected onShutdownCallback: () => void | Promise<any>;

  constructor(options: ServerOptions = {}) {
    this.presence = options.presence;
    this.matchMaker = new MatchMaker(this.presence);

    this.onShutdownCallback = () => Promise.resolve();

    // "presence" option is not used from now on
    delete options.presence;

    registerGracefulShutdown((signal) => {
      this.matchMaker.gracefullyShutdown().
        then(() => this.shutdown()).
        catch((err) => debugError(`error during shutdown: ${err}`)).
        then(() => process.exit());
    });

    if (options.server) {
      this.attach(options);
    }
  }

  public attach(options: ServerOptions) {
    const engine = options.engine || WebSocket.Server;
    delete options.engine;

    if (options.server || options.port) {
      const customVerifyClient: WebSocket.VerifyClientCallbackAsync = options.verifyClient;

      options.verifyClient = (info, next) => {
        if (!customVerifyClient) { return this.verifyClient(info, next); }

        customVerifyClient(info, (verified, code, message) => {
          if (!verified) { return next(verified, code, message); }

          this.verifyClient(info, next);
        });
      };

      this.server = new engine(options);
      this.httpServer = options.server;

    } else {
      this.server = options.ws;
    }

    this.server.on('connection', this.onConnection);

    // interval to detect broken connections
    this.pingInterval = setInterval(() => {
      this.server.clients.forEach((client: Client) => {
        //
        // if client hasn't responded after the interval, terminate its connection.
        //
        if (client.pingCount >= 2) {
          return client.terminate();
        }

        client.pingCount++;
        client.ping(noop);
      });
    }, PING_INTERVAL);
  }

  public listen(port: number, hostname?: string, backlog?: number, listeningListener?: Function) {
    this.httpServer.listen(port, hostname, backlog, listeningListener);
  }

  public register(name: string, handler: RoomConstructor, options: any = {}): RegisteredHandler {
    return this.matchMaker.registerHandler(name, handler, options);
  }

  public onShutdown(callback: () => void | Promise<any>) {
    this.onShutdownCallback = callback;
  }

  protected verifyClient = async (info, next) => {
    const req = info.req;
    const url = parseURL(req.url);
    req.roomId = url.pathname.substr(1);

    const query = parseQueryString(url.query);
    req.colyseusid = query.colyseusid;

    delete query.colyseusid;
    req.options = query;

    if (req.roomId) {
      // TODO: refactor me. this piece of code is repeated on MatchMaker class.
      const hasReservedSeat = await this.matchMaker.remoteRoomCall(req.roomId, 'hasReservedSeat', [query.sessionId]);

      if (!hasReservedSeat) {
        const isLocked = await this.matchMaker.remoteRoomCall(req.roomId, 'locked');

        if (isLocked) {
          return next(false, Protocol.WS_TOO_MANY_CLIENTS, 'maxClients reached.');
        }
      }

      // verify client from room scope.
      this.matchMaker.remoteRoomCall(req.roomId, 'onAuth', [req.options]).
        then((result) => {
          if (!result) { return next(false); }

          req.auth = result;
          next(true);
        }).
        catch((e) => next(false));

    } else {
      next(true);
    }
  }

  protected onConnection = (client: Client, req?: http.IncomingMessage & any) => {
    // compatibility with ws / uws
    const upgradeReq = req || client.upgradeReq;

    // set client id
    client.id = upgradeReq.colyseusid || generateId();
    client.pingCount = 0;

    // ensure client has its "colyseusid"
    if (!upgradeReq.colyseusid) {
      send(client, [Protocol.USER_ID, client.id]);
    }

    // set client options
    client.options = upgradeReq.options;
    client.auth = upgradeReq.auth;

    // prevent server crashes if a single client had unexpected error
    client.on('error', (err) => debugError(err.message + '\n' + err.stack));
    client.on('pong', heartbeat);

    const roomId = upgradeReq.roomId;
    if (roomId) {
      this.matchMaker.connectToRoom(client, upgradeReq.roomId).
        catch((e) => {
          debugError(e.stack || e);
          send(client, [Protocol.JOIN_ERROR, roomId, e && e.message]);
        });

    } else {
      client.on('message',  this.onMessageMatchMaking.bind(this, client));
    }
  }

  protected onMessageMatchMaking(client: Client, message) {
    message = decode(message);

    if (!message) {
      debugError(`couldn't decode message: ${message}`);
      return;
    }

    if (message[0] === Protocol.JOIN_ROOM) {
      const roomName = message[1];
      const joinOptions = message[2];

      joinOptions.clientId = client.id;

      if (!this.matchMaker.hasHandler(roomName) && !isValidId(roomName)) {
        send(client, [Protocol.JOIN_ERROR, roomName, `Error: no available handler for "${roomName}"`]);

      } else {
        this.matchMaker.onJoinRoomRequest(client, roomName, joinOptions).
          then((roomId: string) => send(client, [Protocol.JOIN_ROOM, roomId, joinOptions.requestId])).
          catch((e) => {
            debugError(e.stack || e);
            send(client, [Protocol.JOIN_ERROR, roomName, e && e.message]);
          });
      }

    } else if (message[0] === Protocol.ROOM_LIST) {
      const requestId = message[1];
      const roomName = message[2];

      this.matchMaker.getAvailableRooms(roomName).
        then((rooms) => send(client, [Protocol.ROOM_LIST, requestId, rooms])).
        catch((e) => debugError(e.stack || e));

    } else {
      debugError(`MatchMaking couldn\'t process message: ${message}`);
    }

  }

  protected shutdown()  {
    clearInterval(this.pingInterval);
    return this.onShutdownCallback();
  }

}
