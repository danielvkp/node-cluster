const WsLogger = require("./ws-logger")
const RedisHelper = require("./redis-helper")

const MESSAGES_WAITING = []
const DEVICE_SOCKETS = {}
const TIMER_INTERVAL = 10000

class WaitingMessages {

  static get tag() {
    return 'WaitingMessages'
  }

  constructor(fingerprint) {
    this.fingerprint = fingerprint

    this.redisPool = RedisHelper.create(RedisHelper.REDIS_URL)

    this.redisPool.on("error", function(error) {
      WsLogger.log(WaitingMessages.tag, error, "error", true)
      RedisHelper.close(this)
    })
  }

  send() {
    let queue = "queue.device." + this.fingerprint

    WsLogger.log(WaitingMessages.tag, "queue: " + queue)

    this.redisPool.lrange(queue, 0, -1, function(err, reply) {
      if (err) {
        WsLogger.log(WaitingMessages.tag, "lrange error: " + err, "error", true);
        return RedisHelper.close(this.redisPool);
      }

      WsLogger.log(WaitingMessages.tag, "messages in queue: " + reply.length);

      reply.forEach(message => {
        try {
          DEVICE_SOCKETS[this.fingerprint].send(message)
          WsLogger.log(WaitingMessages.tag, "Device " + this.fingerprint + " relaying message " + message)
        } catch (e) {
          WsLogger.log(WaitingMessages.tag, "Exception in Device " + this.fingerprint + " relaying: " + e.message, "error", true)
        }
      })

      RedisHelper.close(this.redisPool)

    }.bind(this));
  }
}

function startWaitingMessagesTimer() {
  let interval = setInterval(function() {

    WsLogger.log(WaitingMessages.tag, "messages: " + MESSAGES_WAITING.length);

    MESSAGES_WAITING.forEach((fingerprint, a) => {

      WsLogger.log(WaitingMessages.tag, "WAITING_MESSAGES[" + a + "]: " + fingerprint);

      if (DEVICE_SOCKETS[fingerprint]) {
        WsLogger.log(WaitingMessages.tag, "Found in DEVICE_SOCKETS");

        let wms = new WaitingMessages(fingerprint)

        wms.send()

        MESSAGES_WAITING.splice(a, 1)

        return null
      }
      WsLogger.log(WaitingMessages.tag, "Not found in DEVICE_SOCKETS");
    })
  }, TIMER_INTERVAL);
  return interval;
}

function createWaitingMessages(fingerprint) {
  return new WaitingMessages(fingerprint);
}

module.exports.create = createWaitingMessages;
module.exports.startTimer = startWaitingMessagesTimer;
module.exports.MESSAGES_WAITING = MESSAGES_WAITING;
module.exports.DEVICE_SOCKETS = DEVICE_SOCKETS;