const WebSocket = require("ws");
const Redis = require("redis");
const Crypto = require("crypto");
const dotenv = require("dotenv");
const auth = require("./auth");
const winston = require('winston')

dotenv.config();

const logger = winston.createLogger({
  transports: [
    new winston.transports.File({
      filename: 'error.log'
    })
  ]
});

function write_to_log(msg, level = 'info') {
  logger.log({
    date: new Date().toString(),
    level: level,
    message: msg,
  });
}

//helper function to show any log message
function write_log(lg, add_to_log_file = false) {
  console.log(lg);
  if (add_to_log_file) {
    write_to_log(lg);
  }
}

//helper function to close redis connection
function close_redis_connection(rc) {
  try {
    rc.quit();
  } catch (e) {}
}

class WaitingMessageSender {
  constructor(fingerprint) {
    this.fingerprint = fingerprint;
    this.redisPool = Redis.createClient(REDIS_URL);
    this.redisPool.on("error", function(error) {
      write_log("WaitingMessageSender redisPool error: " + error, true);
      close_redis_connection(this);
    });
    //this.redisPool.owner=this;
  }

  send() {
    let queue = "queue.device." + this.fingerprint;
    write_log("WaitingMessagesSender queue: " + queue);
    this.redisPool.lrange(
      queue,
      0,
      -1,
      function(err, reply) {
        if (err) {
          write_log("redisPool lrange error: " + err, true);
          close_redis_connection(this.redisPool);
          return;
        }
        write_log("messages in queue: " + reply.length);
        for (let b = 0; b < reply.length; b++) {
          let message = reply[b];
          try {
            //send this message to DEVICE_SOCKETS[fingerprint]
            //DEVICE_SOCKETS[this.owner.fingerprint].send(message);
            DEVICE_SOCKETS[this.fingerprint].send(message);
            //write_log("Device "+this.owner.fingerprint+" relaying message "+message);
            write_log(
              "Device " + this.fingerprint + " relaying message " + message
            );
          } catch (e) {
            //write_log("Exception in Device "+this.owner.fingerprint+" relaying: "+e.message);
            write_log(
              "Exception in Device " +
              this.fingerprint +
              " relaying: " +
              e.message, true
            );
          }
        }
        close_redis_connection(this.redisPool);
      }.bind(this)
    );
  }
}

class MessageQueuer {
  constructor(fingerprint, message, message_type) {
    this.fingerprint = fingerprint;
    //this.message=message;
    this.message = JSON.parse(JSON.stringify(message));
    this.message_type = message_type;
  }

  get_job_queue() {
    let job_queue = "default";
    switch (this.message_type) {
      case "connection":
      case "connected":
      case "heartbeat":
      case "hash_progress":
      case "hunt_started":
      case "ready":
        job_queue = "pushed-tasks";
        break;
      case "log":
        job_queue = "log";
        break;
      case "thread_evaluation":
      case "ip_info":
        job_queue = "utility";
        break;
      default:
        job_queue = "default";
    }
    return job_queue;
  }

  enqueue() {
    let job_queue = this.get_job_queue(this.message_type);
    if (!this.message.id) {
      this.message.id = this.fingerprint;
    }
    if (!this.message.timestamp) {
      this.message.timestamp = unix_timestamp();
    }
    //let job_args = [{id: this.fingerprint,timestamp: unix_timestamp()}];
    let job_args = [this.message];
    let job_json = {
      queue: job_queue,
      jid: get_hex_string(12),
      class: "DeviceMessageWorker",
      args: job_args,
      created_at: unix_timestamp(),
      enqueued_at: unix_timestamp(),
      retry: true,
    };
    let queue = job_queue;
    const logSideKipPool = sideKiqPool.sadd("queues", "default");
    let jobStr = JSON.stringify(job_json);
    write_log("Sending message to background queue: " + jobStr);
    const logSide = sideKiqPool.lpush("queue:" + queue, jobStr);
    write_log(
      "sideKiqPool Push",
      logSide,
      "SideKipPool S ADD",
      logSideKipPool
    );
  }
}

class MessageHandler {
  constructor(data, socket, fingerprint) {
    this.data = data; //this data is JSON object not a String
    this.socket = socket;
    this.fingerprint = fingerprint;
    this.redisPool = Redis.createClient(REDIS_URL);
    this.redisPool.on("error", function(error) {
      write_log("MessageHandler redisPool error: " + error, true);
      close_redis_connection(this);
    });
    //this.redisPool.owner = this;
  }

  handle() {
    let message_type = this.data["type"];
    if (message_type == "ack") {
      //redispool lrange
      //loop through each message in lrange
      //if payload matches md5 digest of message
      //remove it from the queue using lrem
      let queue = "queue.device." + this.fingerprint;
      this.redisPool.lrange(
        queue,
        0,
        -1,
        function(err, reply) {
          if (err) {
            write_log("redisPool lrange error: " + err);
            close_redis_connection(this.redisPool);
            return;
          }
          for (let b = 0; b < reply.length; b++) {
            let queued_message = reply[b];
            let digest = Crypto.createHash("md5")
              .update(queued_message)
              .digest("hex");
            //if (digest==this.owner.data["payload"]){
            if (digest == this.data["payload"]) {
              //this.lrem("queue.device."+this.owner.fingerprint,0,queued_message);
              this.redisPool.lrem(
                "queue.device." + this.fingerprint,
                0,
                queued_message
              );
            }
          }
          close_redis_connection(this.redisPool);
        }.bind(this)
      );
    } else if (message_type == "ready") {
      this.redisPool.publish("trigger.queue.device", this.fingerprint);
      queue_message(this.fingerprint, this.data, message_type);
      close_redis_connection(this.redisPool);
    } else {
      queue_message(this.fingerprint, this.data, message_type);
      close_redis_connection(this.redisPool);
    }
  }
}

class ConnectionHandler {
  constructor(fingerprint, license_key, socket) {
    this.fingerprint = fingerprint;
    this.license_key = license_key;
    this.socket = socket;
    this.socket.connectionHandler = this;
  }

  handle() {
    this.socket.on("message", function(message) {
      if (this.connectionHandler.onMessage) {
        this.connectionHandler.onMessage(
          message,
          this.connectionHandler.fingerprint,
          this.connectionHandler.license_key,
          this.connectionHandler.socket
        );
      }
    });
    this.socket.on("close", function() {
      if (this.connectionHandler.onClose) {
        this.connectionHandler.onClose(
          this.connectionHandler.fingerprint,
          this.connectionHandler.license_key,
          this.connectionHandler.socket
        );
      }
    });
    this.socket.on("ping", function() {
      if (this.connectionHandler.onPing) {
        this.connectionHandler.onPing(
          this.connectionHandler.fingerprint,
          this.connectionHandler.license_key,
          this.connectionHandler.socket
        );
      }
    });
  }
}

function unix_timestamp(dt) {
  if (!dt) {
    dt = new Date();
  }
  return dt.getTime() / 1000;
}

function get_hex_string(len) {
  const hex = "0123456789ABCDEF";
  let output = "";
  for (let i = 0; i < len; ++i) {
    output += hex.charAt(Math.floor(Math.random() * hex.length));
  }
  return output;
}

function redis_subscribe(redisUrl, pattern, onMessage) {
  const subscriber = Redis.createClient(redisUrl);
  subscriber.on("error", function(error) {
    write_log("subscriber error: " + error, true);
    close_redis_connection(this);
  });
  subscriber.on("subscribe", function(channel, count) {
    write_log("subscribed to: " + channel + ",count: " + count);
  });
  subscriber.on("message", onMessage);
  subscriber.subscribe(pattern);
}

function handle_message(data, socket, fingerprint) {
  write_log("Device " + fingerprint + " sent message " + data);
  let dataObj = null;
  try {
    dataObj = JSON.parse(data);
  } catch (e) {
    write_log("Device " + fingerprint + " sent malformed JSON " + data, true);
    return;
  }
  if (!dataObj["payload"]) {
    dataObj["payload"] = "ping";
  }
  new MessageHandler(dataObj, socket, fingerprint).handle();
}

function queue_message(fingerprint, message, message_type) {
  new MessageQueuer(fingerprint, message, message_type).enqueue();
}

function closed_socket(fingerprint) {
  write_log("Device " + fingerprint + " Disconnected");
  let msg = {
    type: "disconnected",
    timestamp: unix_timestamp()
  };
  queue_message(fingerprint, msg, "connection");
}

function invalid_connection_attempt(socket) {
  write_log("Invalid connection attempt", true);
  socket.send("Status 403; Do not pass go");
  socket.close();
}

function store_socket(fingerprint, license_key, socket) {
  if (!DEVICE_SOCKETS[fingerprint]) {
    DEVICE_SOCKETS[fingerprint] = socket;
  }
}

function send_heartbeat(fingerprint, socket) {
  let currTimestamp = unix_timestamp();
  if (
    !HEARTBEATS[fingerprint] ||
    currTimestamp - HEARTBEATS[fingerprint] > 60 * 4
  ) {
    HEARTBEATS[fingerprint] = currTimestamp;
    write_log("Device " + fingerprint + " heartbeat being refreshed!");
    queue_message(
      fingerprint, {
        type: "heartbeat",
        timestamp: currTimestamp
      },
      "heartbeat"
    );
  }
}

function onConnectionMessage(message, fingerprint, license_key, socket) {
  store_socket(fingerprint, license_key, socket);
  let clean_message = message.trim();
  handle_message(clean_message, socket, fingerprint);
}

function onConnectionPing(fingerprint, license_key, socket) {
  write_log("Received ping from " + fingerprint + ", responding with pong");
  socket.pong();
  send_heartbeat(fingerprint, socket);
}

function onConnectionClose(fingerprint, license_key, socket) {
  closed_socket(fingerprint);
  delete DEVICE_SOCKETS[fingerprint];
  delete HEARTBEATS[fingerprint];
}

function handle_connection(fingerprint, license_key, socket) {
  write_log("Device " + fingerprint + " connected for Customer " + license_key);
  handle_message(
    JSON.stringify({
      type: "connected",
      timestamp: unix_timestamp()
    }),
    socket,
    fingerprint
  );
  store_socket(fingerprint, license_key, socket);
  socket.send("connected");
  socket.send("ready");

  let conn = new ConnectionHandler(fingerprint, license_key, socket);
  conn.onMessage = onConnectionMessage;
  conn.onPing = onConnectionPing;
  conn.onClose = onConnectionClose;
  conn.handle();
}

REDIS_URL = process.env.REDIS_URL; //default url of REDIS server
REDIS_PROVIDER = process.env.HEROKU_REDIS_RED_URL; //default url of REDIS server
SERVER_PORT = process.env.PORT; //port on which server will run00;

const DEVICE_SOCKETS = {};
const HEARTBEATS = {};
const MESSAGES_WAITING = [];

const redisPool = Redis.createClient(REDIS_URL);
const sideKiqPool = Redis.createClient(REDIS_PROVIDER);

redisPool.on("error", function(error) {
  write_log("redisPool error: " + error, true);
});

sideKiqPool.on("error", function(error) {
  write_log("sideKiqPool error: " + error, true);
});

redis_subscribe(REDIS_PROVIDER, "device", function onMessage(channel, message) {
  write_log("Subscriber received message in '" + channel + "': " + message);
  //parse message to JSON
  let device_message = null;
  try {
    device_message = JSON.parse(message);
  } catch (e) {
    write_log("Malformed JSON sent in '" + channel + "': " + message, true);
    return;
  }
  if (DEVICE_SOCKETS[device_message["target"]]) {
    //send device_message["payload"] to DEVICE_SOCKETS[target]
    //for (let a=0;a<DEVICE_SOCKETS.length;a++){
    //DEVICE_SOCKETS[a].send(device_message["payload"]);
    //}
    DEVICE_SOCKETS[device_message["target"]].send(device_message["payload"]);
    write_log(
      "Device " +
      device_message["target"] +
      " relaying message " +
      device_message["payload"]
    );
  } else {
    write_log(
      "Unable to Relay Device " +
      device_message["target"] +
      " message " +
      device_message["payload"], true
    );
  }
});

redis_subscribe(
  REDIS_URL,
  "trigger.queue.device",
  function onMessage(channel, message) {
    write_log("Subscriber received message in '" + channel + "': " + message);
    //message received is a fingerprint of device
    device_fingerprint = message.trim();
    if (DEVICE_SOCKETS[device_fingerprint]) {
      if (!MESSAGES_WAITING.includes(device_fingerprint)) {
        MESSAGES_WAITING.push(device_fingerprint);
      }
    }
  }
);

const messagesWaitingInterval = setInterval(function() {
  write_log("messagesWaitingTimer: " + MESSAGES_WAITING.length);
  for (let a = 0; a < MESSAGES_WAITING.length; a++) {
    let fingerprint = MESSAGES_WAITING[a];
    write_log("WAITING_MESSAGES[" + a + "]: " + fingerprint);
    if (DEVICE_SOCKETS[fingerprint]) {
      write_log("Found in DEVICE_SOCKETS");
      new WaitingMessageSender(fingerprint).send();
    } else {
      write_log("Not found in DEVICE_SOCKETS");
    }
    MESSAGES_WAITING.splice(a, 1);
  }
}, 10000);

const webSocketServer = new WebSocket.Server({
  port: SERVER_PORT
});

webSocketServer.on("connection", function(socket, req) {
  write_log("New connection: " + req.url);
  let vals = req.url.split("/");

  if (vals.length < 3) {
    write_log("Invalid url: " + req.url, true);
    socket.send(JSON.stringify({
      type: "config",
      payload: {}
    }));
    socket.close();
    return;
  }

  let signed_token = vals[3].trim();

  let fingerprint = vals[4].trim();

  fingerprint = fingerprint.toLowerCase();
  write_log("lowercase fingerprint=" + fingerprint);

  let is_valid = auth.verifyToken(signed_token);
  if (is_valid == false) {
    socket.send(JSON.stringify({
      type: "config",
      payload: {}
    }));
    socket.close();

    write_log(`Suggested config update for ${fingerprint}, closed socket`);
    return null;
  }

  let json_object = JSON.parse(is_valid);

  let license_key = json_object.license_key;

  handle_connection(fingerprint, license_key, socket);
});

write_log("Server started");