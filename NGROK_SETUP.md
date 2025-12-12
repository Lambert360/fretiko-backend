# Ngrok Setup Guide for Local Development

## ✅ Ngrok Installed

Ngrok has been installed globally via npm. You can now use it to expose your local backend server to the internet for Flutterwave webhook testing.

## Quick Start

### Step 1: Start Your Backend Server

In one terminal, start your NestJS backend:

```bash
cd fretiko-backend
npm run start:dev
```

Your server should be running on `http://localhost:3000` (or whatever port you configured).

### Step 2: Start Ngrok

In a **new terminal window**, run:

```bash
ngrok http 3000
```

**Note**: If your backend runs on a different port, replace `3000` with your port number.

### Step 3: Copy the Ngrok URL

Ngrok will display something like:

```
Session Status                online
Account                       Your Account (Plan: Free)
Version                       3.x.x
Region                        United States (us)
Latency                       -
Web Interface                 http://127.0.0.1:4040
Forwarding                    https://abc123.ngrok.io -> http://localhost:3000
```

**Copy the HTTPS URL** (e.g., `https://abc123.ngrok.io`)

### Step 4: Update Your .env File

Add the ngrok URL to your `.env` file:

```env
API_URL=https://abc123.ngrok.io
```

**Important**: The ngrok URL changes every time you restart ngrok (on free plan). You'll need to:
1. Update `API_URL` in `.env`
2. Update the webhook URL in Flutterwave dashboard

### Step 5: Configure Flutterwave Webhook

1. Log in to [Flutterwave Dashboard](https://dashboard.flutterwave.com)
2. Go to **Settings** → **Webhooks**
3. Add webhook URL: `https://abc123.ngrok.io/wallet/webhooks/flutterwave`
4. Select events:
   - ✅ `charge.completed`
   - ✅ `charge.failed`
   - ✅ `transfer.completed`
   - ✅ `transfer.failed`
5. Save the webhook

## Ngrok Web Interface

Ngrok provides a web interface to inspect requests:

- **URL**: http://127.0.0.1:4040
- **Features**:
  - View all incoming requests
  - Inspect request/response headers and bodies
  - Replay requests
  - Debug webhook calls from Flutterwave

## Important Notes

### Free Plan Limitations

- **URL Changes**: The ngrok URL changes every time you restart ngrok
- **Session Timeout**: Free sessions may timeout after 2 hours
- **Solution**: Keep ngrok running, or use ngrok's authtoken for persistent URLs (requires account)

### Persistent URLs (Optional)

If you want a persistent URL that doesn't change:

1. Sign up for free ngrok account: https://dashboard.ngrok.com/signup
2. Get your authtoken from dashboard
3. Configure ngrok:
   ```bash
   ngrok config add-authtoken YOUR_AUTHTOKEN
   ```
4. Use a reserved domain (requires paid plan) or keep the free dynamic URL

### Keep Ngrok Running

- **Don't close** the ngrok terminal window while testing
- If ngrok stops, your webhook URL will stop working
- Restart ngrok and update the webhook URL in Flutterwave dashboard

## Testing Webhook

Once ngrok is running and webhook is configured:

1. Make a test deposit or withdrawal
2. Check ngrok web interface (http://127.0.0.1:4040) to see incoming webhook requests
3. Check your backend logs for webhook processing
4. Verify the transaction status in your database

## Troubleshooting

### "Tunnel not found"
- Make sure ngrok is running
- Check the URL is correct (no typos)
- Verify your backend server is running on the correct port

### "Webhook not receiving events"
- Check ngrok is running and forwarding correctly
- Verify webhook URL in Flutterwave dashboard matches ngrok URL
- Check ngrok web interface to see if requests are coming through
- Verify your backend endpoint is accessible

### "Connection refused"
- Make sure your backend server is running
- Check the port number matches (3000 by default)
- Verify firewall isn't blocking the connection

## Alternative: LocalTunnel

If you prefer an alternative to ngrok:

```bash
npm install -g localtunnel
lt --port 3000
```

This provides a similar service but with different URLs.

## Production

**For production**, you don't need ngrok. Use your actual backend domain:

```env
API_URL=https://api.fretiko.com
```

Ngrok is only needed for **local development** when testing webhooks.

