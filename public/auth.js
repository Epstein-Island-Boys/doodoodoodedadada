// auth.js — small fetch helpers shared by login/register/dashboard

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

async function apiGet(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  return res.json();
}

// Pages that only make sense once you've found the hidden door redirect
// back to the decoy if the unlock cookie is missing.
function requireUnlocked() {
  const unlocked = document.cookie
    .split("; ")
    .some((row) => row.startsWith("unlocked=true"));
  if (!unlocked) window.location.href = "/index.html";
}
