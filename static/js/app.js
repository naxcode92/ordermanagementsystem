/**
 * OMS — Order Management System
 * Global JS utilities
 */

// Pre-fill the input form from URL query parameters (used by "Edit" flow)
window.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("orderForm");
  if (!form) return;

  const params = new URLSearchParams(window.location.search);
  const fieldIds = [
    "lead_id",
    "call_sid",
    "date_type",
    "order_date",
    "delivery_failure_date",
    "call_request_date",
    "last_request_date",
    "phone_number",
    "name",
    "call_recording",
  ];

  fieldIds.forEach((id) => {
    const val = params.get(id);
    if (val) {
      const el = document.getElementById(id);
      if (el) el.value = val;
    }
  });
});
