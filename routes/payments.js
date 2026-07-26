const express = require("express");
const router = express.Router();
const db = require("../db");
const stripe = require("../utils/stripeClient");

// Where the customer lands after paying (or backing out of) a Checkout
// page -- static pages in the frontend site, not behind any login.
const FRONTEND_URL = process.env.FRONTEND_URL || "https://site-clock-frontend-production.up.railway.app";

// POST /api/payments/invoices/:id/checkout-session
// Public -- no admin/employee auth. A customer clicking "Pay now" in their
// invoice email has no account to log into, so this is only gated by
// knowing the invoice's own (unguessable, UUID) id, the same trust model
// already used by the invoice PDF link.
//
// Creates a Stripe Checkout Session for the invoice's full balance and hands
// back its hosted URL. Money goes straight to this Stripe account for now
// (Jeremy's own) -- once other companies are onboarded with their own
// connected Stripe accounts, this is the one place that'll need to route
// the charge to the right account instead.
router.post("/invoices/:id/checkout-session", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT i.id, i.invoice_number, i.status, i.total, i.company_id,
              c.name AS customer_name, c.email AS customer_email,
              co.name AS company_name
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

    const session = await stripe.checkout.sessions.create({
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
            unit_amount: Math.round(Number(invoice.total) * 100),
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
    });

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
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
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
  await db.query(
    `UPDATE invoices
     SET status = 'paid', payment_method = 'online', paid_at = now(), stripe_payment_intent_id = $1
     WHERE id = $2 AND status != 'paid'`,
    [session.payment_intent || null, invoiceId]
  );
}

module.exports = { router, handleStripeWebhook };
