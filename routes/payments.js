const express = require("express");
const router = express.Router();
const db = require("../db");
const stripe = require("../utils/stripeClient");
const { sendPaymentReceiptEmail } = require("../utils/mailer");
const { consumeRemainingAfterPulls } = require("../utils/inventory");

// Where the customer lands after paying (or backing out of) a Checkout
// page -- static pages in the frontend site, not behind any login.
const FRONTEND_URL = process.env.FRONTEND_URL || "https://site-clock-frontend-production.up.railway.app";

// Our cut of every payment a connected company collects through the app,
// on top of whatever Stripe itself charges that company for processing.
// Taken automatically by Stripe as part of the one charge the customer
// sees -- see routes/connect.js for how a company links its account.
const PLATFORM_FEE_RATE = 0.005;

// POST /api/payments/invoices/:id/checkout-session
// Public -- no admin/employee auth. A customer clicking "Pay now" in their
// invoice email has no account to log into, so this is only gated by
// knowing the invoice's own (unguessable, UUID) id, the same trust model
// already used by the invoice PDF link.
//
// Creates a Stripe Checkout Session for the invoice's full balance and hands
// back its hosted URL. If the invoice's company has connected its own
// Stripe account (Standard Connect), the charge is created directly on
// that account -- via the `stripeAccount` request option -- with our
// PLATFORM_FEE_RATE cut carved out as an application fee, so their
// customer's money lands in their own Stripe balance, not ours. Companies
// that haven't connected yet (including Jeremy's own, so far) fall back to
// the platform's own Stripe account, unchanged from before Connect existed.
router.post("/invoices/:id/checkout-session", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT i.id, i.invoice_number, i.status, i.total, i.company_id,
              c.name AS customer_name, c.email AS customer_email,
              co.name AS company_name, co.stripe_account_id
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       JOIN companies co ON co.id = i.company_id
       WHERE i.id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Invoice not found." });
    }
    const invoice = result.rows[0];

    if (invoice.status === "paid") {
      return res.status(400).json({ error: "This invoice has already been paid." });
    }
    if (invoice.status === "void") {
      return res.status(400).json({ error: "This invoice has been voided." });
    }
    if (!(Number(invoice.total) > 0)) {
      return res.status(400).json({ error: "This invoice doesn't have a balance due." });
    }

    const connectedAccountId = invoice.stripe_account_id || null;

    // Every company -- including Jeremy's own -- must connect its own
    // Stripe account before it can accept an online payment. There's no
    // fallback to the platform's own account: charging on the platform
    // account directly and also taking an "application fee" from it makes
    // no sense (you can't take a cut of your own money), and skipping the
    // fee for one company but not others would be an inconsistent special
    // case. So this is a hard requirement for everyone, no exceptions.
    if (!connectedAccountId) {
      return res.status(400).json({
        error: "This business hasn't finished setting up online payments yet. Ask them to connect Stripe in their Billing settings.",
      });
    }

    const totalCents = Math.round(Number(invoice.total) * 100);

    const sessionParams = {
      mode: "payment",
      payment_method_types: ["card", "us_bank_account"],
      customer_email: invoice.customer_email || undefined,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Invoice #${invoice.invoice_number} — ${invoice.company_name}`,
            },
            unit_amount: totalCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        invoice_id: invoice.id,
        company_id: invoice.company_id,
      },
      success_url: `${FRONTEND_URL}/pay-success.html?invoice=${invoice.id}`,
      cancel_url: `${FRONTEND_URL}/pay-cancelled.html?invoice=${invoice.id}`,
    };

    const requestOptions = {};
    if (connectedAccountId) {
      sessionParams.payment_intent_data = {
        application_fee_amount: Math.round(totalCents * PLATFORM_FEE_RATE),
      };
      requestOptions.stripeAccount = connectedAccountId;
    }

    const session = await stripe.checkout.sessions.create(sessionParams, requestOptions);

    await db.query(`UPDATE invoices SET stripe_checkout_session_id = $1 WHERE id = $2`, [session.id, invoice.id]);

    res.json({ url: session.url });
  } catch (err) {
    console.error("POST /payments/invoices/:id/checkout-session failed:", err);
    res.status(500).json({ error: "Couldn't start payment. Please try again." });
  }
});

// Handles Stripe's webhook events for Checkout Sessions. Registered in
// server.js *before* the global express.json() middleware, using
// express.raw() for this exact path -- Stripe's signature verification
// needs the untouched raw request body, not the parsed JS object.
//
// Card payments resolve immediately (checkout.session.completed with
// payment_status "paid"). ACH/bank-account payments are "delayed" --
// Checkout completes as soon as the customer submits their bank details,
// but the money isn't actually confirmed for a few business days, which is
// what the separate async_payment_succeeded/failed events are for.
async function handleStripeWebhook(req, res) {
  await processStripeWebhookEvent(req, res, process.env.STRIPE_WEBHOOK_SECRET);
}

// Same handling as handleStripeWebhook, but for the second webhook
// destination Stripe requires for events on *connected* accounts (a company
// that's linked its own Stripe account via Connect). Stripe signs these
// with a different secret and needs its own "listen to Connected accounts"
// destination in the dashboard -- see routes/connect.js for the connect
// flow itself. The actual invoice-marking logic is identical either way,
// since metadata.invoice_id already tells us which invoice this is for
// regardless of which Stripe account the event came from.
async function handleStripeConnectWebhook(req, res) {
  await processStripeWebhookEvent(req, res, process.env.STRIPE_CONNECT_WEBHOOK_SECRET);
}

async function processStripeWebhookEvent(req, res, signingSecret) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], signingSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const session = event.data.object;

    if (event.type === "checkout.session.completed" && session.payment_status === "paid") {
      await markInvoicePaidFromStripe(session);
    } else if (event.type === "checkout.session.async_payment_succeeded") {
      await markInvoicePaidFromStripe(session);
    } else if (event.type === "checkout.session.async_payment_failed") {
      // The bank-account payment bounced after the fact (e.g. insufficient
      // funds) -- the invoice was never marked paid in the first place (that
      // only happens on success above), so there's nothing to undo. Logged
      // so it's visible in Sentry rather than silently vanishing.
      console.error(`ACH payment failed for invoice ${session.metadata && session.metadata.invoice_id}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook handling failed:", err);
    // Non-2xx makes Stripe retry this event automatically for a few days,
    // which is the right behavior for a transient DB hiccup here.
    res.status(500).json({ error: "Webhook handler failed" });
  }
}

async function markInvoicePaidFromStripe(session) {
  const invoiceId = session.metadata && session.metadata.invoice_id;
  if (!invoiceId) return;

  const result = await db.query(
    `UPDATE invoices
     SET status = 'paid', payment_method = 'online', paid_at = now(), stripe_payment_intent_id = $1
     WHERE id = $2 AND status != 'paid'
     RETURNING *`,
    [session.payment_intent || null, invoiceId]
  );
  // rowCount is 0 if this invoice was already marked paid -- e.g. Stripe
  // re-delivering the same webhook event, which it does retry on occasion.
  // Nothing new happened, so there's nothing new to send a receipt for.
  if (result.rowCount === 0) return;
  const invoice = result.rows[0];

  // Same "paid means the reserved stock is actually gone" consumption as the
  // manual mark-paid route -- this is the other of the two paths that can
  // ever set an invoice to "paid" (see admin.js PATCH /invoices/:id/mark-paid).
  // Only whatever hasn't already been pulled via a fulfilled pull sheet gets
  // subtracted, so material grabbed ahead of payment isn't double-consumed.
  const paidItems = await db.query(
    `SELECT catalog_item_id, quantity FROM invoice_line_items WHERE invoice_id = $1`,
    [invoiceId]
  );
  await consumeRemainingAfterPulls(paidItems.rows, "invoice", invoiceId, invoice.company_id);

  const detail = await db.query(
    `SELECT c.name AS customer_name, c.email AS customer_email, co.name AS company_name, co.stripe_account_id
     FROM invoices i
     JOIN customers c ON c.id = i.customer_id
     JOIN companies co ON co.id = i.company_id
     WHERE i.id = $1`,
    [invoiceId]
  );
  const row = detail.rows[0];

  // Records what this payment actually cost to accept -- Stripe's own
  // processing fee (varies by payment method, so it can't just be
  // calculated) plus our platform cut -- so Reports can show real profit
  // instead of pretending the full invoice total landed in the bank. Best
  // effort: this is a nice-to-have on top of the payment itself already
  // being recorded above, so a hiccup fetching it (or an older invoice with
  // no connected account on file) shouldn't be treated as the payment
  // failing.
  if (session.payment_intent && row && row.stripe_account_id) {
    try {
      const pi = await stripe.paymentIntents.retrieve(
        session.payment_intent,
        { expand: ["latest_charge.balance_transaction"] },
        { stripeAccount: row.stripe_account_id }
      );
      const charge = pi.latest_charge;
      const balanceTxn = charge && charge.balance_transaction;
      if (balanceTxn) {
        const stripeFee = balanceTxn.fee / 100;
        const platformFee = (charge.application_fee_amount || 0) / 100;
        await db.query(
          `UPDATE invoices SET stripe_processing_fee = $1, platform_fee = $2 WHERE id = $3`,
          [stripeFee, platformFee, invoiceId]
        );
      }
    } catch (err) {
      console.error(`Failed to record processing fee for invoice ${invoiceId}:`, err.message);
    }
  }

  try {
    if (row && row.customer_email) {
      await sendPaymentReceiptEmail({ to: row.customer_email, companyName: row.company_name, invoice });
    }
  } catch (err) {
    // A failed receipt email shouldn't undo the payment already being
    // recorded above -- just log it (Sentry picks it up via the global
    // handler) rather than losing the failure silently.
    console.error("Failed to send payment receipt email:", err.message);
  }
}

module.exports = { router, handleStripeWebhook, handleStripeConnectWebhook };
