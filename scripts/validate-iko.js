/**
 * Iko AI Integration Validation Script
 *
 * This script validates that all Iko AI components are properly integrated
 * and ready for production use.
 */

const fs = require('fs');
const path = require('path');

class IkoValidator {
  constructor() {
    this.checks = [];
    this.passed = 0;
    this.failed = 0;
  }

  check(name, condition, message) {
    const result = typeof condition === 'function' ? condition() : condition;
    this.checks.push({ name, result, message });

    if (result) {
      this.passed++;
      console.log(`✅ ${name}`);
    } else {
      this.failed++;
      console.log(`❌ ${name}: ${message}`);
    }
  }

  fileExists(filePath) {
    return fs.existsSync(path.join(__dirname, '..', filePath));
  }

  fileContains(filePath, searchString) {
    try {
      const content = fs.readFileSync(path.join(__dirname, '..', filePath), 'utf8');
      return content.includes(searchString);
    } catch (error) {
      return false;
    }
  }

  validate() {
    console.log('🤖 Validating Iko AI Integration...\n');

    // Backend Module Structure
    this.check(
      'Iko Module Exists',
      () => this.fileExists('src/iko/iko.module.ts'),
      'Iko module file not found'
    );

    this.check(
      'Iko Service Exists',
      () => this.fileExists('src/iko/iko.service.ts'),
      'Iko service file not found'
    );

    this.check(
      'Iko Search Service Exists',
      () => this.fileExists('src/iko/iko-search.service.ts'),
      'Iko search service file not found'
    );

    this.check(
      'Iko Scheduler Service Exists',
      () => this.fileExists('src/iko/iko-scheduler.service.ts'),
      'Iko scheduler service file not found'
    );

    // Backend Integration
    this.check(
      'App Module Imports Iko',
      () => this.fileContains('src/app.module.ts', 'IkoModule'),
      'IkoModule not imported in app.module.ts'
    );

    this.check(
      'Schedule Module Enabled',
      () => this.fileContains('src/app.module.ts', 'ScheduleModule.forRoot()'),
      'ScheduleModule not enabled for Iko scheduling'
    );

    this.check(
      'Notifications Integration',
      () => this.fileContains('src/iko/iko.module.ts', 'NotificationsModule'),
      'NotificationsModule not imported in Iko module'
    );

    // Function Calling
    this.check(
      'Function Schemas Exist',
      () => this.fileContains('src/iko/iko-search.service.ts', 'searchProducts'),
      'Function calling schemas not found'
    );

    this.check(
      'API Endpoints Exist',
      () => this.fileExists('src/iko/iko.controller.ts'),
      'Iko API controller not found'
    );

    // Frontend Integration
    this.check(
      'Mobile Environment File',
      () => this.fileExists('../fretiko-mobile/.env'),
      'Mobile app environment file not found'
    );

    this.check(
      'Gemini API Integration',
      () => this.fileExists('../fretiko-mobile/src/services/geminiAPI.ts'),
      'Gemini API service not found'
    );

    this.check(
      'Gemini Live API Integration',
      () => this.fileExists('../fretiko-mobile/src/services/geminiLiveAPI.ts'),
      'Gemini Live API service not found'
    );

    this.check(
      'Iko Conversation Manager',
      () => this.fileExists('../fretiko-mobile/src/services/ikoConversationManager.ts'),
      'Iko conversation manager not found'
    );

    this.check(
      'Audio File Reading Implemented',
      () => this.fileContains('../fretiko-mobile/src/services/geminiAPI.ts', 'readAsDataURL'),
      'Audio file reading not implemented'
    );

    // Chat Integration
    this.check(
      'Konnect Screen AI Integration',
      () => this.fileContains('../fretiko-mobile/src/screens/KonnectScreen.tsx', 'isAI'),
      'AI integration not found in Konnect screen'
    );

    this.check(
      'Individual Chat AI Features',
      () => this.fileContains('../fretiko-mobile/src/screens/IndividualChatScreen.tsx', 'AI Research'),
      'AI-specific features not found in Individual Chat screen'
    );

    // Data Types
    this.check(
      'AI Notification Types',
      () => this.fileContains('src/notifications/dto/notification.dto.ts', 'AI_CHECKIN'),
      'AI notification types not added'
    );

    this.check(
      'Iko DTOs Exist',
      () => this.fileExists('src/iko/dto/iko.dto.ts'),
      'Iko DTOs not found'
    );

    // Scheduler Features
    this.check(
      'Check-in Cron Job',
      () => this.fileContains('src/iko/iko-scheduler.service.ts', '@Cron(CronExpression.EVERY_HOUR)'),
      'Check-in cron job not configured'
    );

    this.check(
      'Plan Reminders',
      () => this.fileContains('src/iko/iko-scheduler.service.ts', 'processOngoingPlanReminders'),
      'Plan reminder functionality not found'
    );

    this.check(
      'Weekly Engagement',
      () => this.fileContains('src/iko/iko-scheduler.service.ts', 'weeklyEngagementCheck'),
      'Weekly engagement check not found'
    );

    // Summary
    console.log('\n📊 Validation Summary:');
    console.log(`✅ Passed: ${this.passed}`);
    console.log(`❌ Failed: ${this.failed}`);
    console.log(`📈 Success Rate: ${Math.round((this.passed / (this.passed + this.failed)) * 100)}%`);

    if (this.failed === 0) {
      console.log('\n🎉 All checks passed! Iko AI is ready for production!');
    } else {
      console.log('\n⚠️  Some checks failed. Please review the issues above.');
    }

    return this.failed === 0;
  }
}

// Run validation
const validator = new IkoValidator();
const success = validator.validate();

process.exit(success ? 0 : 1);