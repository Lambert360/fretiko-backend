# Winston Logger Setup Guide

## Environment Configuration

### Development (default)
```bash
NODE_ENV=development
# Log levels: DEBUG, INFO, WARN, ERROR
# Format: Colored, readable output
```

### Production (Render)
```bash
NODE_ENV=production
# Log levels: WARN, ERROR only (for performance)
# Format: JSON for log analysis
# Also writes errors to logs/error.log
```

### Testing
```bash
NODE_ENV=test
# Log levels: ERROR only
```

## Usage in Services

```typescript
import { WinstonLoggerService } from '../logger/winston.logger.service';

@Injectable()
export class YourService {
  constructor(private logger: WinstonLoggerService) {}

  someMethod() {
    this.logger.log('Information message', 'YourService');
    this.logger.warn('Warning message', 'YourService');
    this.logger.error('Error message', 'stack trace', 'YourService');
    this.logger.debug('Debug message', 'YourService'); // Won't log in production
  }
}
```

## Performance Benefits

- **Production**: Only WARN and ERROR logs (minimal overhead)
- **Development**: Full logging for debugging
- **JSON format**: Faster processing in production
- **Async operations**: Non-blocking log writes
- **Conditional logging**: Checks level before processing

## Render Deployment

The logger automatically detects NODE_ENV=production and:
- Disables debug/info logs for performance
- Uses JSON format for better log analysis
- Writes errors to both console and file
- Optimized for high-performance scenarios

## Testing the Setup

```bash
# Development (full logs)
npm run start:dev

# Production (errors/warnings only)
NODE_ENV=production npm run start:prod
```
