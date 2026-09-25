/**
 * FRETIKO EMAIL REMINDER TEMPLATES
 * HTML builders for transactional reminder emails sent via Resend.
 * Shared layout keeps branding consistent with the auth email templates.
 */

const BRAND_COLOR = '#F39C12';
const BRAND_GRADIENT = 'linear-gradient(135deg, #F39C12 0%, #E67E22 100%)';

interface EmailContent {
  heading: string;
  emoji?: string;
  paragraphs: string[];
  infoBox?: string;
  cta?: { label: string; url: string };
  accentColor?: string;
  signOff?: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(content: EmailContent): string {
  const accent = content.accentColor || BRAND_COLOR;
  const paragraphs = content.paragraphs
    .map(p => `<p style="font-size: 16px; margin-bottom: 16px;">${p}</p>`)
    .join('\n');

  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(content.heading)} - Fretiko</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4;">
    <div style="max-width: 600px; margin: 0 auto; background-color: white; border-radius: 10px; overflow: hidden; box-shadow: 0 0 20px rgba(0,0,0,0.1);">
        <div style="background: ${BRAND_GRADIENT}; padding: 30px; text-align: center;">
            <h1 style="color: #ffffff; margin: 0; font-size: 26px;">${content.emoji ? content.emoji + ' ' : ''}${esc(content.heading)}</h1>
        </div>
        <div style="padding: 30px;">
            ${paragraphs}
            ${content.infoBox ? `
            <div style="background-color: #FFF8EC; border-left: 4px solid ${accent}; padding: 15px; margin: 20px 0; border-radius: 4px;">
                ${content.infoBox}
            </div>` : ''}
            ${content.cta ? `
            <div style="text-align: center; margin: 30px 0;">
                <a href="${esc(content.cta.url)}"
                   style="display: inline-block; background: ${accent}; color: #ffffff; padding: 14px 36px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
                    ${esc(content.cta.label)}
                </a>
            </div>` : ''}
            ${content.signOff ? `
            <p style="font-size: 16px; margin-bottom: 16px;">${content.signOff}</p>` : ''}
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
            <p style="color: #666; font-size: 13px;">
                You received this email because of activity on your Fretiko account.
                You can turn off email reminders in Settings &rarr; Notifications.
            </p>
        </div>
        <div style="text-align: center; font-size: 12px; color: #666; padding: 20px; background-color: #F9FAFB;">
            <p style="margin: 0;">&copy; 2026 Fretiko. All rights reserved.</p>
            <p style="margin: 4px 0 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
    </div>
</body>
</html>`;
}

function fmt(amount: number): string {
  return `₣${Number(amount).toFixed(2)}`;
}

function fmtDate(iso: string | Date): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

function greeting(name?: string): string {
  return `Hi ${esc(name || 'there')},`;
}

// ============================================
// AUCTIONS
// ============================================

export function auctionWonEmail(opts: {
  name?: string; title: string; amount: number;
  expiresAt?: string | Date; promoted?: boolean; appUrl: string;
}): string {
  return layout({
    heading: 'You Won the Auction!',
    emoji: '🎉',
    paragraphs: [
      greeting(opts.name),
      opts.promoted
        ? `The previous buyer did not complete checkout, so <strong>"${esc(opts.title)}"</strong> is now yours at your bid of <strong>${fmt(opts.amount)}</strong>.`
        : `Congratulations! You won <strong>"${esc(opts.title)}"</strong> with a bid of <strong>${fmt(opts.amount)}</strong>.`,
      'Complete checkout to secure your purchase.',
    ],
    infoBox: opts.expiresAt
      ? `<p style="margin: 0;"><strong>⏰ Checkout deadline:</strong> ${fmtDate(opts.expiresAt)}</p>
         <p style="margin: 6px 0 0;">If you miss the deadline, the win expires and the item may go to the next bidder.</p>`
      : `<p style="margin: 0;">Complete checkout promptly — if the checkout window expires, the item may go to the next bidder.</p>`,
    cta: { label: 'Complete Checkout', url: opts.appUrl },
  });
}

export function auctionWinCheckoutReminderEmail(opts: {
  name?: string; title: string; amount: number;
  expiresAt: string | Date; hoursLeft: number; appUrl: string;
}): string {
  const urgent = opts.hoursLeft <= 2;
  return layout({
    heading: urgent ? 'Final Reminder: Checkout Expiring' : 'Reminder: Complete Your Checkout',
    emoji: '⏰',
    accentColor: urgent ? '#E74C3C' : BRAND_COLOR,
    paragraphs: [
      greeting(opts.name),
      `Your win on <strong>"${esc(opts.title)}"</strong> (${fmt(opts.amount)}) is still waiting for checkout.`,
    ],
    infoBox:
      `<p style="margin: 0;"><strong>Time remaining:</strong> about ${opts.hoursLeft} hour${opts.hoursLeft === 1 ? '' : 's'} (expires ${fmtDate(opts.expiresAt)})</p>
       <p style="margin: 6px 0 0;">After the deadline your win expires, your held funds are released, and the item may go to the next bidder.</p>`,
    cta: { label: 'Complete Checkout Now', url: opts.appUrl },
  });
}

export function auctionEndingSoonEmail(opts: {
  name?: string; title: string; minutesLeft: number;
  currentBid?: number; appUrl: string;
}): string {
  return layout({
    heading: 'Auction Ending Soon',
    emoji: '🔔',
    paragraphs: [
      greeting(opts.name),
      `<strong>"${esc(opts.title)}"</strong> ends in about <strong>${opts.minutesLeft} minute${opts.minutesLeft === 1 ? '' : 's'}</strong>.`,
      opts.currentBid != null ? `Current bid: <strong>${fmt(opts.currentBid)}</strong>.` : '',
    ].filter(Boolean),
    cta: { label: 'View Auction', url: opts.appUrl },
  });
}

export function outbidEmail(opts: {
  name?: string; title: string; amount: number; appUrl: string;
}): string {
  return layout({
    heading: "You've Been Outbid",
    emoji: '⚠️',
    paragraphs: [
      greeting(opts.name),
      `Someone outbid you on <strong>"${esc(opts.title)}"</strong> — the bid is now <strong>${fmt(opts.amount)}</strong>.`,
      'Head back to the auction to place a higher bid before it ends.',
    ],
    cta: { label: 'Bid Again', url: opts.appUrl },
  });
}

export function auctionWinExpiredEmail(opts: {
  name?: string; title: string; appUrl: string;
}): string {
  return layout({
    heading: 'Auction Win Expired',
    paragraphs: [
      greeting(opts.name),
      `Your checkout window for <strong>"${esc(opts.title)}"</strong> has expired.`,
      'Any held funds were released back to your wallet, and the item may have gone to the next bidder.',
    ],
    cta: { label: 'Browse Auctions', url: opts.appUrl },
  });
}

export function auctionWinForfeitedEmail(opts: {
  name?: string; title: string; amount: number; appUrl: string;
}): string {
  return layout({
    heading: 'Auction Win Forfeited',
    accentColor: '#E74C3C',
    paragraphs: [
      greeting(opts.name),
      `Your winning bid of <strong>${fmt(opts.amount)}</strong> on <strong>"${esc(opts.title)}"</strong> could not be completed because your wallet balance was insufficient.`,
      'The item went to the next bidder. Top up your wallet before bidding to avoid losing future wins.',
    ],
    cta: { label: 'Top Up Wallet', url: opts.appUrl },
  });
}

export function auctionSaleFailedEmail(opts: {
  name?: string; title: string; appUrl: string;
}): string {
  return layout({
    heading: 'Auction Sale Failed',
    accentColor: '#E74C3C',
    paragraphs: [
      greeting(opts.name),
      `The sale of <strong>"${esc(opts.title)}"</strong> could not be completed — the winning bidders did not pay. The item was marked as passed.`,
      'You can relist the item in a new auction whenever you are ready.',
    ],
    cta: { label: 'View My Auctions', url: opts.appUrl },
  });
}

/**
 * Generic notification email — used by the notification funnel to mirror
 * in-app notifications (order updates, payments, disputes, etc.) to email.
 */
export function genericNotificationEmail(opts: {
  name?: string; title: string; message: string;
  ctaLabel?: string; appUrl: string;
}): string {
  return layout({
    heading: opts.title,
    paragraphs: [
      greeting(opts.name),
      esc(opts.message),
    ],
    cta: { label: opts.ctaLabel || 'Open Fretiko', url: opts.appUrl },
  });
}

/**
 * Welcome email — sent once after a new account is created, covering both
 * manual (email + verification code) and social (Google/Apple) signups.
 */
export function welcomeEmail(opts: { name?: string; appUrl: string }): string {
  return layout({
    heading: 'Welcome to Fretiko',
    emoji: '🎉',
    paragraphs: [
      greeting(opts.name),
      'Thank you for joining our community — your account is ready.',
      'Fretiko is a social marketplace where people connect, bid in live auctions, and buy and sell with escrow-protected orders.',
    ],
    infoBox: `
      <p style="margin: 0 0 8px;"><strong>What you can do on Fretiko</strong></p>
      <ul style="margin: 0; padding-left: 20px; line-height: 1.8;">
        <li>Join live auctions and place bids in real time</li>
        <li>Watch live streams and shop live sales as they happen</li>
        <li>Buy and sell with escrow-protected payments</li>
        <li>Track orders and deliveries end to end</li>
        <li>List your own items and grow your storefront</li>
        <li>Connect with the community and discover new listings</li>
      </ul>`,
    cta: { label: 'Open Fretiko', url: opts.appUrl },
    signOff: 'Best regards,<br>The Fretiko Team',
  });
}

/**
 * Admin broadcast email — body arrives already personalized
 * ({{name}} etc. replaced per recipient), so no extra greeting.
 */
export function broadcastEmail(opts: {
  heading: string; body: string;
  ctaLabel?: string; ctaUrl?: string; appUrl: string;
}): string {
  const bodyHtml = esc(opts.body).replace(/\n/g, '<br>');
  return layout({
    heading: opts.heading,
    paragraphs: [bodyHtml],
    cta: opts.ctaLabel
      ? { label: opts.ctaLabel, url: opts.ctaUrl || opts.appUrl }
      : undefined,
  });
}

// ============================================
// ORDERS & ESCROW
// ============================================

export function orderPendingVendorEmail(opts: {
  name?: string; orderNumber: string; total: number; appUrl: string;
}): string {
  return layout({
    heading: 'Order Awaiting Action',
    emoji: '📦',
    paragraphs: [
      greeting(opts.name),
      `Order <strong>#${esc(opts.orderNumber)}</strong> (${fmt(opts.total)}) has been pending for over 24 hours.`,
      'Please confirm and prepare the order so the buyer is not left waiting.',
    ],
    cta: { label: 'View Order', url: opts.appUrl },
  });
}

export function orderConfirmReceiptEmail(opts: {
  name?: string; orderNumber: string; appUrl: string;
}): string {
  return layout({
    heading: 'Confirm Your Delivery',
    emoji: '📬',
    paragraphs: [
      greeting(opts.name),
      `Order <strong>#${esc(opts.orderNumber)}</strong> was marked as delivered over 24 hours ago.`,
      'If everything arrived as expected, please confirm receipt so the seller can be paid. If something is wrong, open a dispute instead.',
    ],
    cta: { label: 'Review Order', url: opts.appUrl },
  });
}

export function escrowAutoReleaseEmail(opts: {
  name?: string; orderNumber: string; amount: number;
  releaseAt: string | Date; appUrl: string;
}): string {
  return layout({
    heading: 'Escrow Releasing Soon',
    emoji: '💰',
    paragraphs: [
      greeting(opts.name),
      `The escrow for order <strong>#${esc(opts.orderNumber)}</strong> (${fmt(opts.amount)}) will automatically release to the seller on <strong>${fmtDate(opts.releaseAt)}</strong>.`,
      'If you have received your order, confirm receipt now. If there is a problem, open a dispute before the release time.',
    ],
    infoBox: `<p style="margin: 0;">Once escrow auto-releases, disputes can no longer be opened for this order.</p>`,
    cta: { label: 'Review Order', url: opts.appUrl },
  });
}
