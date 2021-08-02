/* eslint-disable prettier/prettier */
class ConnectionHandler {
  constructor(fingerprint, license_key, socket) {
    this.fingerprint = fingerprint
    this.license_key = license_key
    this.socket = socket
    this.socket.connectionHandler = this
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

    this.socket.on("error", function() {
      if (this.connectionHandler.onError) {
        this.connectionHandler.onError(
          this.connectionHandler.fingerprint,
          this.connectionHandler.license_key,
          this.connectionHandler.socket
        );
      }
    });
  }
}

function createConnectionHandler(fingerprint, license_key, socket) {
  return new ConnectionHandler(fingerprint, license_key, socket);
}

module.exports.create = createConnectionHandler;