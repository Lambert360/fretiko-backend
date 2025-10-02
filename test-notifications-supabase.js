#!/usr/bin/env node

/**
 * FRETIKO NOTIFICATIONS SYSTEM TESTER - SUPABASE JWT VERSION
 * Tests notification endpoints using Supabase JWT tokens directly
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE_URL = 'http://192.168.43.135:3000';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(colors[color] + message + colors.reset);
}

function logTest(testName) {
  log(`\n🧪 Testing: ${testName}`, 'cyan');
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

let supabase;
let testToken = null;
let testUserId = null;

/**
 * Initialize Supabase client and authenticate
 */
async function initializeAuth() {
  logTest('Initialize Supabase Authentication');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    logError('Missing Supabase credentials in .env file');
    return false;
  }

  logSuccess(`Supabase URL: ${supabaseUrl}`);
  logSuccess(`Supabase Key: ${supabaseKey.substring(0, 20)}...`);

  supabase = createClient(supabaseUrl, supabaseKey);

  // Try to create and authenticate a test user
  const testEmail = `test-notif-${Date.now()}@example.com`;
  logSuccess(`Creating test user: ${testEmail}`);

  try {
    const { data, error } = await supabase.auth.signUp({
      email: testEmail,
      password: 'TestPassword123!',
      options: {
        data: {
          first_name: 'Test',
          last_name: 'User'
        }
      }
    });

    if (error) {
      logWarning(`Signup error: ${error.message}`);

      // If signup failed, try to signin (user might already exist)
      const { data: signinData, error: signinError } = await supabase.auth.signInWithPassword({
        email: testEmail,
        password: 'TestPassword123!'
      });

      if (signinError) {
        logError(`Both signup and signin failed: ${signinError.message}`);
        return false;
      } else {
        data = signinData;
      }
    }

    if (data.session) {
      testToken = data.session.access_token;
      testUserId = data.user.id;
      logSuccess(`✅ Authenticated successfully!`);
      logSuccess(`User ID: ${testUserId}`);
      logSuccess(`JWT Token: ${testToken.substring(0, 30)}...`);
      return true;
    } else {
      logError('No session returned - email confirmation might be required');
      logWarning('Check your Supabase auth settings to disable email confirmation for testing');
      return false;
    }

  } catch (error) {
    logError(`Auth failed: ${error.message}`);
    return false;
  }
}

/**
 * Test creating notifications
 */
async function testCreateNotification() {
  logTest('Create Test Notification');

  const testNotification = {
    user_id: testUserId,
    type: 'system',
    title: '🎉 Welcome to Fretiko!',
    message: 'Your notification system is working perfectly! This is a test notification created via API.',
    priority: 'medium',
    badge: 'NEW',
    has_actions: true,
    action_buttons: [
      { label: 'Get Started', type: 'primary' },
      { label: 'Learn More', type: 'secondary' }
    ],
    data: {
      test: true,
      timestamp: new Date().toISOString(),
      source: 'notification-tester'
    }
  };

  try {
    const response = await fetch(`${BASE_URL}/notifications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify(testNotification)
    });

    if (response.ok) {
      const notification = await response.json();
      logSuccess(`Notification created: ${notification.id}`);
      logSuccess(`Title: ${notification.title}`);
      logSuccess(`Type: ${notification.type}`);
      logSuccess(`Has actions: ${notification.has_actions}`);
      return notification;
    } else {
      const errorText = await response.text();
      logError(`Create failed: ${response.status} ${response.statusText}`);
      logError(`Error: ${errorText}`);
      return null;
    }
  } catch (error) {
    logError(`Create notification failed: ${error.message}`);
    return null;
  }
}

/**
 * Test getting user notifications
 */
async function testGetNotifications() {
  logTest('Get User Notifications');

  try {
    const response = await fetch(`${BASE_URL}/notifications?limit=10&sort_by=created_at&sort_order=desc`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${testToken}`
      }
    });

    if (response.ok) {
      const data = await response.json();
      logSuccess(`Retrieved ${data.notifications.length} notifications`);
      logSuccess(`Total: ${data.total}, Has more: ${data.has_more}`);

      // Show details of first few notifications
      data.notifications.slice(0, 3).forEach((notif, index) => {
        logSuccess(`${index + 1}. ${notif.title} (${notif.type}) - Read: ${notif.is_read}`);
      });

      return data.notifications;
    } else {
      const errorText = await response.text();
      logError(`Get failed: ${response.status} ${response.statusText}`);
      logError(`Error: ${errorText}`);
      return [];
    }
  } catch (error) {
    logError(`Get notifications failed: ${error.message}`);
    return [];
  }
}

/**
 * Test notification stats
 */
async function testNotificationStats() {
  logTest('Get Notification Stats');

  try {
    const response = await fetch(`${BASE_URL}/notifications/stats`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${testToken}`
      }
    });

    if (response.ok) {
      const stats = await response.json();
      logSuccess(`📊 Notification Stats:`);
      logSuccess(`  Total notifications: ${stats.total_notifications}`);
      logSuccess(`  Unread count: ${stats.unread_count}`);
      logSuccess(`  Unread orders: ${stats.unread_orders}`);
      logSuccess(`  Unread social: ${stats.unread_social}`);
      logSuccess(`  Unread live: ${stats.unread_live}`);
      logSuccess(`  Unread payment: ${stats.unread_payment}`);
      logSuccess(`  Unread chat: ${stats.unread_chat}`);
      return stats;
    } else {
      const errorText = await response.text();
      logError(`Stats failed: ${response.status} ${response.statusText}`);
      logError(`Error: ${errorText}`);
      return null;
    }
  } catch (error) {
    logError(`Stats test failed: ${error.message}`);
    return null;
  }
}

/**
 * Test unread count endpoint
 */
async function testUnreadCount() {
  logTest('Get Unread Count');

  try {
    const response = await fetch(`${BASE_URL}/notifications/unread-count`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${testToken}`
      }
    });

    if (response.ok) {
      const result = await response.json();
      logSuccess(`🔔 Unread count: ${result.unread_count}`);
      return result;
    } else {
      const errorText = await response.text();
      logError(`Unread count failed: ${response.status} ${response.statusText}`);
      logError(`Error: ${errorText}`);
      return null;
    }
  } catch (error) {
    logError(`Unread count failed: ${error.message}`);
    return null;
  }
}

/**
 * Test mark notification as read
 */
async function testMarkAsRead(notificationId) {
  if (!notificationId) {
    logWarning('No notification ID to test mark as read');
    return null;
  }

  logTest('Mark Notification as Read');

  try {
    const response = await fetch(`${BASE_URL}/notifications/${notificationId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        is_read: true
      })
    });

    if (response.ok) {
      const updatedNotif = await response.json();
      logSuccess(`Marked as read: ${updatedNotif.id}`);
      logSuccess(`Is read: ${updatedNotif.is_read}`);
      return updatedNotif;
    } else {
      const errorText = await response.text();
      logError(`Mark as read failed: ${response.status} ${response.statusText}`);
      logError(`Error: ${errorText}`);
      return null;
    }
  } catch (error) {
    logError(`Mark as read failed: ${error.message}`);
    return null;
  }
}

/**
 * Create multiple test notifications of different types
 */
async function createMultipleTestNotifications() {
  logTest('Create Multiple Test Notifications');

  const notifications = [
    {
      user_id: testUserId,
      type: 'order',
      title: '🛒 Order Confirmed',
      message: 'Your order #FRT-12345 has been confirmed and is being prepared.',
      badge: 'CONFIRMED',
      priority: 'medium',
      has_actions: true,
      action_buttons: [
        { label: 'Track Order', type: 'primary' },
        { label: 'Contact Seller', type: 'secondary' }
      ]
    },
    {
      user_id: testUserId,
      type: 'social',
      title: '💬 New Connection Request',
      message: 'Sarah Johnson wants to connect with you on Fretiko.',
      badge: 'REQUEST',
      priority: 'medium',
      has_actions: true,
      action_buttons: [
        { label: 'Accept', type: 'primary' },
        { label: 'Decline', type: 'secondary' }
      ]
    },
    {
      user_id: testUserId,
      type: 'live',
      title: '🔴 Live Sale Starting',
      message: 'FlashDeals is going live with 50% off electronics in 2 minutes!',
      badge: 'LIVE',
      priority: 'high',
      has_actions: true,
      action_buttons: [
        { label: 'Join Live Sale', type: 'primary' }
      ]
    },
    {
      user_id: testUserId,
      type: 'payment',
      title: '💳 Payment Successful',
      message: 'Your payment of $49.99 for Order #FRT-12345 has been processed.',
      badge: 'PAID',
      priority: 'medium'
    },
    {
      user_id: testUserId,
      type: 'delivery',
      title: '🚚 Rider On The Way',
      message: 'Your delivery driver John is 5 minutes away from your location.',
      badge: 'ARRIVING',
      priority: 'high',
      has_actions: true,
      action_buttons: [
        { label: 'Track Live', type: 'primary' },
        { label: 'Call Driver', type: 'secondary' }
      ]
    }
  ];

  const created = [];

  for (const notif of notifications) {
    try {
      const response = await fetch(`${BASE_URL}/notifications`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testToken}`
        },
        body: JSON.stringify(notif)
      });

      if (response.ok) {
        const createdNotif = await response.json();
        logSuccess(`✅ Created ${notif.type}: ${notif.title}`);
        created.push(createdNotif);
      } else {
        const errorText = await response.text();
        logError(`Failed ${notif.type}: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      logError(`Error creating ${notif.type}: ${error.message}`);
    }
  }

  return created;
}

/**
 * Main test runner
 */
async function runNotificationTests() {
  log('\n🔔 FRETIKO NOTIFICATIONS SYSTEM TESTER', 'bright');
  log('========================================', 'bright');

  let passed = 0;
  let failed = 0;

  try {
    // Step 1: Initialize Auth
    log('\n📋 Step 1: Authentication & Setup', 'yellow');
    const authSuccess = await initializeAuth();
    if (authSuccess) {
      passed++;
      logSuccess('✅ Authentication successful');
    } else {
      failed++;
      logError('❌ Authentication failed - cannot proceed');
      return;
    }

    // Step 2: Create single notification
    log('\n📋 Step 2: Create Single Notification', 'yellow');
    const notification = await testCreateNotification();
    if (notification) {
      passed++;
    } else {
      failed++;
    }

    // Step 3: Get notifications
    log('\n📋 Step 3: Get User Notifications', 'yellow');
    const notifications = await testGetNotifications();
    if (notifications && notifications.length > 0) {
      passed++;
    } else {
      failed++;
    }

    // Step 4: Get stats
    log('\n📋 Step 4: Get Notification Stats', 'yellow');
    const stats = await testNotificationStats();
    if (stats) {
      passed++;
    } else {
      failed++;
    }

    // Step 5: Get unread count
    log('\n📋 Step 5: Get Unread Count', 'yellow');
    const unreadCount = await testUnreadCount();
    if (unreadCount !== null) {
      passed++;
    } else {
      failed++;
    }

    // Step 6: Mark as read
    if (notification) {
      log('\n📋 Step 6: Mark Notification as Read', 'yellow');
      const readResult = await testMarkAsRead(notification.id);
      if (readResult) {
        passed++;
      } else {
        failed++;
      }
    }

    // Step 7: Create multiple notifications
    log('\n📋 Step 7: Create Multiple Test Notifications', 'yellow');
    const multipleNotifs = await createMultipleTestNotifications();
    if (multipleNotifs.length > 0) {
      passed++;
      logSuccess(`Created ${multipleNotifs.length} test notifications`);
    } else {
      failed++;
    }

    // Step 8: Final check - get all notifications
    log('\n📋 Step 8: Final Notification Check', 'yellow');
    const finalNotifs = await testGetNotifications();
    if (finalNotifs && finalNotifs.length > 0) {
      passed++;
      logSuccess(`System now has ${finalNotifs.length} total notifications`);
    } else {
      failed++;
    }

  } catch (error) {
    logError(`Test runner failed: ${error.message}`);
    failed++;
  }

  // Final results
  log('\n🎯 TEST RESULTS', 'bright');
  log('===============', 'bright');
  log(`✅ Tests Passed: ${passed}`, 'green');
  log(`❌ Tests Failed: ${failed}`, 'red');

  if (failed === 0) {
    log('\n🎉 ALL TESTS PASSED!', 'green');
    log('🔔 Your notification system is working perfectly!', 'green');
    log('📱 You can now test it in the mobile app', 'blue');
  } else {
    log(`\n⚠️  ${failed} test(s) failed. Check the errors above.`, 'yellow');
  }

  // Show test user info for mobile app testing
  if (testUserId && testToken) {
    log('\n📱 FOR MOBILE APP TESTING:', 'cyan');
    log(`Test User ID: ${testUserId}`, 'blue');
    log(`JWT Token: ${testToken.substring(0, 40)}...`, 'blue');
  }
}

// Run the tests
runNotificationTests().catch(console.error);