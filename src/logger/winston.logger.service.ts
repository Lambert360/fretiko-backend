import { LoggerService as NestLoggerService, Injectable } from '@nestjs/common';
import * as winston from 'winston';

@Injectable()
export class WinstonLoggerService implements NestLoggerService {
  private logger: winston.Logger;

  constructor() {
    const isProduction = process.env.NODE_ENV === 'production';
    const isTest = process.env.NODE_ENV === 'test';

    // Define log levels
    const logLevels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
      verbose: 4,
    };

    // Create Winston logger
    this.logger = winston.createLogger({
      levels: logLevels,
      // Only log errors and warnings in production
      level: isProduction ? 'warn' : isTest ? 'error' : 'verbose',
      
      // Format for production (JSON) vs development (readable)
      format: isProduction 
        ? winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            winston.format.json()
          )
        : winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, context, stack }) => {
              const contextStr = context ? `[${context}] ` : '';
              const stackStr = stack ? `\n${stack}` : '';
              return `${timestamp} ${level}: ${contextStr}${message}${stackStr}`;
            })
          ),

      // Transports (where to send logs)
      transports: [
        // Always log to console (Render will capture this)
        new winston.transports.Console({
          // In production, don't colorize output
          format: isProduction 
            ? winston.format.combine(
                winston.format.timestamp(),
                winston.format.errors({ stack: true }),
                winston.format.json()
              )
            : winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
              )
        }),
        
        // In production, also log errors to a file
        ...(isProduction ? [
          new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            format: winston.format.combine(
              winston.format.timestamp(),
              winston.format.json()
            )
          })
        ] : [])
      ],

      // Handle exceptions and rejections
      exceptionHandlers: [
        new winston.transports.Console()
      ],
      
      rejectionHandlers: [
        new winston.transports.Console()
      ]
    });
  }

  // Implement NestJS LoggerService interface
  log(message: string, context?: string): void {
    this.logger.info(message, { context });
  }

  error(message: string, trace?: string, context?: string): void {
    this.logger.error(message, { context, trace });
  }

  warn(message: string, context?: string): void {
    this.logger.warn(message, { context });
  }

  debug(message: string, context?: string): void {
    this.logger.debug(message, { context });
  }

  verbose(message: string, context?: string): void {
    this.logger.verbose(message, { context });
  }

  // Additional Winston-specific methods
  // Method to change log level at runtime
  setLogLevel(level: string): void {
    this.logger.level = level;
  }

  // Method to get current log level
  getLogLevel(): string {
    return this.logger.level;
  }

  // Method to check if a level is enabled
  isLevelEnabled(level: string): boolean {
    return this.logger.isLevelEnabled(level);
  }
}
