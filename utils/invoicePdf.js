const PDFDocument = require("pdfkit");

const PAYMENT_TERMS_LABELS = {
  due_on_receipt: "Due on receipt",
  net_15: "Net 15",
  net_30: "Net 30",
  net_60: "Net 60",
  net_90: "Net 90",
};

function fmtMoney(n) {
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// Draws a customer's identity for a "Bill to:"/"Prepared for:" block. When a
// company name is on file, that's what should read first and bold -- a
// business's own paperwork/checks reference the company, not necessarily
// whichever person happened to be the contact -- with the person's name
// underneath in normal weight. Falls back to just the person's name (bold)
// when there's no company on file. Returns the y position right after the
// name block so the caller can keep stacking email/phone/address below it.
function drawCustomerIdentity(doc, customer, x, y) {
  let cursorY = y;
  if (customer.company_name) {
    doc.font("Helvetica-Bold").text(customer.company_name, x, cursorY);
    cursorY += 14;
    doc.font("Helvetica").text(customer.name, x, cursorY);
  } else {
    doc.font("Helvetica-Bold").text(customer.name, x, cursorY);
    doc.font("Helvetica");
  }
  return cursorY + 14;
}

// Renders a single-page invoice PDF and resolves with a Buffer. logoBuffer
// is optional (a company's uploaded logo, read straight from the bytea
// column) -- if present it's drawn top-left and the company name shifts
// right to make room. If the image data is ever invalid, the logo is
// silently skipped rather than blocking the invoice from sending.
function renderInvoicePdf({ companyName, invoice, customer, lineItems, logoBuffer, payUrl }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "letter", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Header: logo (optional) top-left, company name next to it, invoice
    // number top-right. Every piece here uses explicit x/y so the two
    // columns can never run into each other regardless of name length.
    const headerTop = 50;
    let nameX = 50;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, 50, headerTop, { fit: [90, 50] });
        nameX = 150;
      } catch (imgErr) {
        nameX = 50;
      }
    }
    doc.fontSize(18).fillColor("#000").text(companyName || "Invoice", nameX, headerTop, { width: 250 });
    doc.fontSize(10).fillColor("#666").text(`Invoice #${invoice.invoice_number}`, 350, headerTop + 4, { width: 200, align: "right" });

    // Fixed reset below the header block -- not derived from doc.y, so the
    // rest of the layout is unaffected by logo height or name wrapping.
    doc.x = 50;
    doc.y = headerTop + 75;

    const topY = doc.y;
    doc.fontSize(10).fillColor("#000").text("Bill to:", 50, topY);
    let billY = drawCustomerIdentity(doc, customer, 50, topY + 14);
    if (customer.email) { doc.text(customer.email, 50, billY); billY += 14; }
    if (customer.phone) { doc.text(customer.phone, 50, billY); billY += 14; }
    const addressParts = [customer.street, [customer.city, customer.state].filter(Boolean).join(", "), customer.zip]
      .filter(Boolean);
    if (addressParts.length) { doc.text(addressParts.join(", "), 50, billY, { width: 250 }); }

    doc.fontSize(10).fillColor("#000")
      .text(`Issue date: ${fmtDate(invoice.issue_date)}`, 350, topY, { align: "right" })
      .text(`Due date: ${fmtDate(invoice.due_date)}`, 350, topY + 14, { align: "right" })
      .text(`Terms: ${PAYMENT_TERMS_LABELS[invoice.payment_terms] || invoice.payment_terms}`, 350, topY + 28, { align: "right" });

    doc.moveDown(4);
    const tableTop = doc.y + 10;
    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("Description", 50, tableTop);
    doc.text("Qty", 330, tableTop, { width: 50, align: "right" });
    doc.text("Unit price", 380, tableTop, { width: 80, align: "right" });
    doc.text("Amount", 470, tableTop, { width: 80, align: "right" });
    doc.moveTo(50, tableTop + 16).lineTo(550, tableTop + 16).strokeColor("#ccc").stroke();

    doc.font("Helvetica").fontSize(10);
    let rowY = tableTop + 24;
    lineItems.forEach((item) => {
      const amount = Number(item.quantity) * Number(item.unit_price);
      doc.text(item.description, 50, rowY, { width: 270 });
      doc.text(String(item.quantity), 330, rowY, { width: 50, align: "right" });
      doc.text(fmtMoney(item.unit_price), 380, rowY, { width: 80, align: "right" });
      doc.text(fmtMoney(amount), 470, rowY, { width: 80, align: "right" });
      rowY += 20;
    });

    doc.moveTo(50, rowY + 4).lineTo(550, rowY + 4).strokeColor("#ccc").stroke();
    let totalsY = rowY + 14;
    doc.text("Subtotal", 380, totalsY, { width: 80, align: "right" });
    doc.text(fmtMoney(invoice.subtotal), 470, totalsY, { width: 80, align: "right" });
    totalsY += 16;
    if (Number(invoice.tax_rate) > 0) {
      doc.text(`Tax (${Number(invoice.tax_rate)}%)`, 380, totalsY, { width: 80, align: "right" });
      doc.text(fmtMoney(invoice.tax_amount), 470, totalsY, { width: 80, align: "right" });
      totalsY += 16;
    }
    doc.font("Helvetica-Bold");
    doc.text("Total due", 380, totalsY, { width: 80, align: "right" });
    doc.text(fmtMoney(invoice.total), 470, totalsY, { width: 80, align: "right" });

    let afterTotalsY = totalsY + 20;
    if (payUrl && invoice.status !== "paid" && invoice.status !== "void") {
      // Clickable link text only -- no raw URL shown -- but the link
      // destination (payUrl) is unchanged underneath.
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#C1502E")
        .text("Click here to pay now", 50, afterTotalsY, { width: 500, link: payUrl, underline: true });
      afterTotalsY += 26;
    }

    if (invoice.notes) {
      doc.font("Helvetica").fontSize(9).fillColor("#666");
      doc.text(invoice.notes, 50, afterTotalsY, { width: 500 });
    }

    doc.end();
  });
}

// Renders a single-page quote/estimate PDF -- same layout as the invoice PDF
// (logo, party info, line-item table, totals) with the header/date fields
// swapped for what a quote actually needs: no payment terms, an "expires"
// date instead of a "due" date, and "Estimate total" instead of "Total due"
// since nothing is actually owed yet.
function renderQuotePdf({ companyName, quote, customer, lineItems, logoBuffer }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "letter", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const headerTop = 50;
    let nameX = 50;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, 50, headerTop, { fit: [90, 50] });
        nameX = 150;
      } catch (imgErr) {
        nameX = 50;
      }
    }
    doc.fontSize(18).fillColor("#000").text(companyName || "Quote", nameX, headerTop, { width: 250 });
    doc.fontSize(10).fillColor("#666").text(`Quote #${quote.quote_number}`, 350, headerTop + 4, { width: 200, align: "right" });

    doc.x = 50;
    doc.y = headerTop + 75;

    const topY = doc.y;
    doc.fontSize(10).fillColor("#000").text("Prepared for:", 50, topY);
    let billY = drawCustomerIdentity(doc, customer, 50, topY + 14);
    if (customer.email) { doc.text(customer.email, 50, billY); billY += 14; }
    if (customer.phone) { doc.text(customer.phone, 50, billY); billY += 14; }
    const addressParts = [customer.street, [customer.city, customer.state].filter(Boolean).join(", "), customer.zip]
      .filter(Boolean);
    if (addressParts.length) { doc.text(addressParts.join(", "), 50, billY, { width: 250 }); }

    doc.fontSize(10).fillColor("#000")
      .text(`Issue date: ${fmtDate(quote.issue_date)}`, 350, topY, { align: "right" });
    if (quote.expiration_date) {
      doc.text(`Valid until: ${fmtDate(quote.expiration_date)}`, 350, topY + 14, { align: "right" });
    }

    doc.moveDown(4);
    const tableTop = doc.y + 10;
    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("Description", 50, tableTop);
    doc.text("Qty", 330, tableTop, { width: 50, align: "right" });
    doc.text("Unit price", 380, tableTop, { width: 80, align: "right" });
    doc.text("Amount", 470, tableTop, { width: 80, align: "right" });
    doc.moveTo(50, tableTop + 16).lineTo(550, tableTop + 16).strokeColor("#ccc").stroke();

    doc.font("Helvetica").fontSize(10);
    let rowY = tableTop + 24;
    lineItems.forEach((item) => {
      const amount = Number(item.quantity) * Number(item.unit_price);
      doc.text(item.description, 50, rowY, { width: 270 });
      doc.text(String(item.quantity), 330, rowY, { width: 50, align: "right" });
      doc.text(fmtMoney(item.unit_price), 380, rowY, { width: 80, align: "right" });
      doc.text(fmtMoney(amount), 470, rowY, { width: 80, align: "right" });
      rowY += 20;
    });

    doc.moveTo(50, rowY + 4).lineTo(550, rowY + 4).strokeColor("#ccc").stroke();
    let totalsY = rowY + 14;
    doc.text("Subtotal", 380, totalsY, { width: 80, align: "right" });
    doc.text(fmtMoney(quote.subtotal), 470, totalsY, { width: 80, align: "right" });
    totalsY += 16;
    if (Number(quote.tax_rate) > 0) {
      doc.text(`Tax (${Number(quote.tax_rate)}%)`, 380, totalsY, { width: 80, align: "right" });
      doc.text(fmtMoney(quote.tax_amount), 470, totalsY, { width: 80, align: "right" });
      totalsY += 16;
    }
    doc.font("Helvetica-Bold");
    doc.text("Estimate total", 380, totalsY, { width: 80, align: "right" });
    doc.text(fmtMoney(quote.total), 470, totalsY, { width: 80, align: "right" });

    if (quote.notes) {
      doc.font("Helvetica").fontSize(9).fillColor("#666");
      doc.text(quote.notes, 50, totalsY + 40, { width: 500 });
    }

    doc.end();
  });
}

// Renders a printable pull sheet -- a plain picking list, not a billing
// document, so there's no pricing on it at all: just what job it's for, who
// it's for, and a checkbox + item + quantity per row so whoever's gathering
// stock can physically tick items off while pulling them.
function renderPullSheetPdf({ companyName, sheet, items }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "letter", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const headerTop = 50;
    doc.fontSize(18).fillColor("#000").text(companyName || "Pull Sheet", 50, headerTop, { width: 300 });
    doc.fontSize(10).fillColor("#666").text("PULL SHEET", 350, headerTop + 4, { width: 200, align: "right" });

    doc.x = 50;
    doc.y = headerTop + 50;
    const topY = doc.y;
    doc.fontSize(10).fillColor("#000");
    doc.font("Helvetica-Bold").text("For:", 50, topY);
    doc.font("Helvetica").text(sheet.source_label || "", 90, topY);
    doc.font("Helvetica-Bold").text("Customer:", 50, topY + 16);
    // Company name leads (when the customer has one on file), person's name
    // after in parens -- same "company first" treatment as the invoice/quote
    // Bill to/Prepared for blocks, just kept to one line here since this is
    // a compact picking-list header, not a full address block.
    const pullSheetCustomerLabel = sheet.customer_company_name
      ? `${sheet.customer_company_name} (${sheet.customer_name || ""})`
      : (sheet.customer_name || "");
    doc.font("Helvetica").text(pullSheetCustomerLabel, 110, topY + 16);
    doc.font("Helvetica-Bold").text("Built:", 350, topY, { width: 60 });
    doc.font("Helvetica").text(fmtDate(sheet.created_at), 410, topY, { width: 140 });
    if (sheet.status === "fulfilled" && sheet.fulfilled_at) {
      doc.font("Helvetica-Bold").text("Fulfilled:", 350, topY + 16, { width: 60 });
      doc.font("Helvetica").text(fmtDate(sheet.fulfilled_at), 410, topY + 16, { width: 140 });
    }

    doc.moveDown(4);
    const tableTop = doc.y + 16;
    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("", 50, tableTop, { width: 24 });
    doc.text("Item", 84, tableTop);
    doc.text("Quantity", 470, tableTop, { width: 80, align: "right" });
    doc.moveTo(50, tableTop + 16).lineTo(550, tableTop + 16).strokeColor("#ccc").stroke();

    doc.font("Helvetica").fontSize(10);
    let rowY = tableTop + 24;
    // Items already arrive pre-sorted by sort_order (see the route) so a
    // section header only needs to print when this item's section differs
    // from the previous one -- consecutive same-section items are already
    // grouped together by that order.
    let lastSection;
    items.forEach((item) => {
      if (item.section_name && item.section_name !== lastSection) {
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#333").text(item.section_name, 50, rowY, { width: 500 });
        rowY += 20;
        doc.font("Helvetica").fillColor("#000");
      }
      lastSection = item.section_name;
      doc.rect(50, rowY - 2, 14, 14).strokeColor("#666").stroke();
      doc.text(item.name, 84, rowY, { width: 370 });
      doc.text(String(item.quantity), 470, rowY, { width: 80, align: "right" });
      rowY += 26;
    });

    doc.end();
  });
}

module.exports = { renderInvoicePdf, renderQuotePdf, renderPullSheetPdf };
