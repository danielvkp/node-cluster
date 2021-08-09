const WsHelper = require("./ws-helper");
const WsLogger = require("./ws-logger");

class MessageQueuer {

  static get tag() {
    return 'MessageQueuer'
  }

  constructor(fingerprint, message, message_type, sideKiqPool) {
    this.fingerprint = fingerprint;
    this.message = JSON.parse(JSON.stringify(message));
    this.message_type = message_type;
    this.sideKiqPool = sideKiqPool;
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
    let job_queue = this.get_job_queue(this.message_type)

    if (!this.message.id) {
      this.message.id = this.fingerprint
    }

    if (!this.message.timestamp) {
      this.message.timestamp = WsHelper.unixTimestamp()
    }

    let job_args = [this.message]

    let job_json = {
      queue: job_queue,
      jid: WsHelper.getHexString(12),
      class: "DeviceMessageWorker",
      args: job_args,
      created_at: WsHelper.unixTimestamp(),
      enqueued_at: WsHelper.unixTimestamp(),
      retry: true,
    }

    let queue = job_queue

    this.sideKiqPool.sadd("queues", "default")

    let jobStr = JSON.stringify(job_json)

    WsLogger.log(MessageQueuer.tag, "Sending message to background queue: " + jobStr)

    this.sideKiqPool.lpush("queue:" + queue, jobStr)

    this.sideKiqPool

  }
}

function createMessageQueuer(fingerprint, message, message_type, sideKiqPool) {
  return new MessageQueuer(fingerprint, message, message_type, sideKiqPool)
}

module.exports.create = createMessageQueuer
