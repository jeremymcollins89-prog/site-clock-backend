require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const timeEntryRoutes = require("./routes/timeEntries");
const timesheetRoutes = require("./routes/timesheets");
const adminRoutes = require("./routes/admin");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/time-entries", timeEntryRoutes);
app.use("/api/timesheets", timesheetRoutes);
app.use("/api/admin", adminRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Site Clock API listening on port ${PORT}`));