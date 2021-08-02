/* eslint-disable prettier/prettier */
const winston = require('winston')

const logger = winston.createLogger({
    transports: [
        new winston.transports.File({ filename: 'error.log' })
    ]
});

class WsLogger {

    static logToFile(msg,level='info'){
        logger.log({
            date: new Date().toString(),
            level: level,
            message: msg,
        });
    }

    // level=info,error,warn,debug
    // log_to_file=true -> write msg to winston logger also, default false
    static log(tag,msg,level='info',log_to_file=false){
        msg=tag+"::"+msg;
        switch(level){
            case 'info':
                console.info(msg);
                break;
            case 'error':
                console.error(msg);
                break;
            case 'warn':
                console.warn(msg);
                break;
            case 'debug':
                console.debug(msg);
                break;
            default:
                console.log(msg);
        }
        if (log_to_file){
            WsLogger.logToFile(msg,level);
        }
    }
}

module.exports.log = WsLogger.log;