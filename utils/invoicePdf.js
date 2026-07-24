const PDFDocument = require("pdfkit");

const PAYMENT_TERMS_LABELS = {
  due_on_receipt: "Due on receipt",
  net_15: "Net 15",
  net_30: "Net 30",
  net_60: "Net 60",
  net_90: "Net 90",
};

function fmtMoney(n) {
  return `$${Number(n).toFixed(2)}`;
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// Renders a single-page invoice PDF and resolves with a Buffer. Kept
// deliberately plain (no logo/branding assets) so it doesn't depend on
// anything beyond the invoice data itself.
function renderInvoicePdf({ companyName, invoice, customer, lineItems }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "letter", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text(companyName || "Invoice", { continued: true });
    doc.fontSize(20).text("", { align: "right" });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#666").text(`Invoice #${invoice.invoice_number}`);
    doc.moveDown(1);

    const topY = doc.y;
    doc.fontSize(10).fillColor("#000").text("Bill to:", 50, topY);
    doc.font("Helvetica-Bold").text(customer.name, 50, topY + 14);
    doc.font("Helvetica");
    let billY = topY + 28;
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

    if (invoice.notes) {
      doc.font("Helvetica").fontSize(9).fillColor("#666");
      doc.text(invoice.notes, 50, totalsY + 40, { width: 500 });
    }

    doc.end();
  });
}

module.exports = { renderInvoicePdf };
