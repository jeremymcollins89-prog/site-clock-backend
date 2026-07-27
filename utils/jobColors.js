// The 7 selectable job colors, shared by validation here and by the admin
// app / employee app UI (hardcoded there too, since they're separate
// projects) so a color name always maps to the same swatch everywhere.
const JOB_COLORS = {
  rust: "#FF4433",
  amber: "#FFA400",
  teal: "#00B871",
  blue: "#1E88FF",
  purple: "#9B30FF",
  rose: "#FF2D95",
  charcoal: "#707B85",
  // Bright yellow -- system-assigned for approved time-off events (see
  // schema-time-off.sql), but also selectable manually like any other
  // color since nothing stops an admin from picking it themselves.
  yellow: "#FFE400",
};

module.exports = { JOB_COLORS };
