const WebSocket = require('ws')
const WsLogger = require('./ws-logger')
const WsHelper = require('./ws-helper')
const RedisHelper = require('./redis-helper')
const WaitingMessages = require('./waiting-messages')
const MessageQueuer = require('./message-queuer')
const MessageHandler = require('./message-handler')
const ConnectionHandler = require('./connection-handler')
/* Import Cluster */
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const process = require('process');
/* End cluster */

const unix_timestamp = dt => WsHelper.unixTimestamp(dt)

function write_log(lg, log_to_file = false) {
  let logType = log_to_file ? 'error' : 'info'
  WsLogger.log('index.js', lg, logType, log_to_file);
}

function redis_subscribe(redisUrl, pattern, onMessage) {
  const subscriber = RedisHelper.create(redisUrl)
  RedisHelper.subscribe(subscriber, pattern, onMessage)
}

function handle_message(data, socket, fingerprint) {
  write_log('Device ' + fingerprint + ' sent message ' + data)

  let dataObj = null

  try {
    dataObj = JSON.parse(data)
  } catch (e) {
    return write_log('Device ' + fingerprint + ' sent malformed JSON ' + data, true)
  }
  if (!dataObj.payload) {
    dataObj.payload = 'ping'
  }
  MessageHandler.create(dataObj, socket, fingerprint, sideKiqPool).handle()
}

function queue_message(fingerprint, message, message_type) {
  MessageQueuer.create(
    fingerprint,
    message,
    message_type,
    sideKiqPool
  ).enqueue()
}

function store_socket(fingerprint, license_key, socket) {
  if (!WaitingMessages.DEVICE_SOCKETS[fingerprint]) {
    WaitingMessages.DEVICE_SOCKETS[fingerprint] = socket;
  }
}

function send_heartbeat(fingerprint, socket) {
  const currTimestamp = unix_timestamp()

  if (!HEARTBEATS[fingerprint] || currTimestamp - HEARTBEATS[fingerprint] > 60 * 4) {

    HEARTBEATS[fingerprint] = currTimestamp

    write_log('Device ' + fingerprint + ' heartbeat being refreshed!');

    queue_message(fingerprint, {
        type: 'heartbeat',
        timestamp: currTimestamp
      },
      'heartbeat'
    );
  }
}

function onConnectionMessage(message, fingerprint, license_key, socket) {
  store_socket(fingerprint, license_key, socket);
  const clean_message = message.trim();
  handle_message(clean_message, socket, fingerprint);
}

function onConnectionPing(fingerprint, license_key, socket) {
  write_log('Received ping from ' + fingerprint + ', responding with pong');
  socket.pong();
  send_heartbeat(fingerprint, socket);
}

function onConnectionClose(fingerprint, license_key, socket) {
  write_log('Device ' + fingerprint + ' Disconnected')

  const msg = {
    type: 'disconnected',
    timestamp: unix_timestamp()
  }

  queue_message(fingerprint, msg, 'connection')

  delete WaitingMessages.DEVICE_SOCKETS[fingerprint]
  delete HEARTBEATS[fingerprint]
}

function onConnectionError(fingerprint, license_key, socket) {
  write_log(`Error on device ${fingerprint}`)
  socket.close()
}

function handle_connection(fingerprint, license_key, socket) {
  write_log('Device ' + fingerprint + ' connected for Customer ' + license_key);

  let message = JSON.stringify({
    type: 'connected',
    timestamp: unix_timestamp()
  })

  handle_message(message, socket, fingerprint)

  store_socket(fingerprint, license_key, socket)

  socket.send('connected')

  socket.send('ready')

  const conn = ConnectionHandler.create(fingerprint, license_key, socket)
  conn.onMessage = onConnectionMessage
  conn.onPing = onConnectionPing
  conn.onClose = onConnectionClose
  conn.onError = onConnectionError
  conn.handle()
}

// variables and script start ------------------------------//
const SERVER_PORT = process.env.PORT || 3000; // port on which server will run00;
const HEARTBEATS = {}
const redisPool = RedisHelper.create(RedisHelper.REDIS_URL)
const sideKiqPool = RedisHelper.create(RedisHelper.REDIS_PROVIDER)

/*const webSocketServer = new WebSocket.Server({
  port: SERVER_PORT
})*/

redisPool.on('error', (error) => write_log('redisPool error: ' + error, true))

sideKiqPool.on('error', (error) => write_log('sideKiqPool error: ' + error, true))

redis_subscribe(RedisHelper.REDIS_PROVIDER, 'device', (channel, message) => {
  write_log("Subscriber received message in '" + channel + "': " + message)

  let device_message = null

  try {
    device_message = JSON.parse(message)
  } catch (e) {
    return write_log("Malformed JSON sent in '" + channel + "': " + message, true);
  }

  if (WaitingMessages.DEVICE_SOCKETS[device_message.target]) {

    WaitingMessages.DEVICE_SOCKETS[device_message.target].send(device_message.payload)

    write_log(`Device ${device_message.target} relaying message ${device_message.payload}`)
  } else {
    write_log(`Unable to Relay Device ${device_message.target} message ${device_message.payload}`, true)
  }
})

redis_subscribe(RedisHelper.REDIS_URL, 'trigger.queue.device', (channel, message) => {
  write_log(`Subscriber received message in ${channel} :  ${message}`)

  device_fingerprint = message.trim()

  let socket_exists = WaitingMessages.DEVICE_SOCKETS[device_fingerprint]

  let has_no_messages = !WaitingMessages.MESSAGES_WAITING.includes(device_fingerprint)

  if (socket_exists && has_no_messages) {
    WaitingMessages.MESSAGES_WAITING.push(device_fingerprint);
  }
})

WaitingMessages.startTimer()

function sendSuggestConfig(socket) {
  socket.send(JSON.stringify({
    type: 'config',
    payload: {}
  }))
}

function startSocket(webSocketServer){
   webSocketServer.on('connection', (socket, req) => {

    write_log('New connection: ' + req.url)

    try {
      const data = WsHelper.validateUrl(req.url)

      if (data === false) {
        write_log(`Invalid url: ${req.url}`, true)

        sendSuggestConfig(socket)

        return socket.close()
      }

      const signed_token = data[0]

      const fingerprint = data[1].toLowerCase()

      write_log('fingerprint=' + fingerprint + ',signed_token=' + signed_token, true);

      const is_valid = WsHelper.verifyToken(signed_token)

      if (is_valid == false) {

        sendSuggestConfig(socket)

        socket.close();

        write_log('Suggested config update for ' + fingerprint + ', closed socket');

        return null
      }

      const json_object = JSON.parse(is_valid)

      const {
        license_key
      } = json_object

      handle_connection(fingerprint, license_key, socket)

    } catch (e) {
      write_log('Exception in on-connection: ' + e.message, true);
    }
  });

}

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} is running`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`worker ${worker.process.pid} died`);
  });

  cluster.on('error', (err) => {
    console.log(`error on worker ${err}`);
  });

} else {
  const webSocketServer = new WebSocket.Server({
    port: SERVER_PORT
  })
  startSocket(webSocketServer)
  console.log(`Worker ${process.pid} started`);
}

write_log('Server started on port ' + SERVER_PORT, true);
