// reveal.js
// This is a party trick, not a security boundary. Real auth happens
// server-side via the session cookie set on /api/login — anyone who opens
// devtools can flip this "unlocked" cookie by hand and it only ever shows
// them the login/register screen, never someone else's data.

const COOKIE_NAME = "unlocked";

function getCookie(name) {
  return document.cookie
    .split("; ")
    .find((row) => row.startsWith(name + "="))
    ?.split("=")[1];
}

function setCookie(name, value, days) {
  const maxAge = days * 24 * 60 * 60;
  document.cookie = `${name}=${value}; path=/; max-age=${maxAge}; samesite=lax`;
}

function clearCookie(name) {
  document.cookie = `${name}=; path=/; max-age=0`;
}

function showSecret() {
  document.getElementById("decoy").hidden = true;
  const secret = document.getElementById("secret");
  secret.hidden = false;
  // next frame so the transition actually runs
  requestAnimationFrame(() => secret.classList.add("visible"));
}

function showDecoy() {
  document.getElementById("secret").classList.remove("visible");
  document.getElementById("secret").hidden = true;
  document.getElementById("decoy").hidden = false;
}

// On load: if already unlocked, skip straight past the decoy.
if (getCookie(COOKIE_NAME) === "true") {
  showSecret();
}

document.getElementById("hotspot").addEventListener("click", () => {
  setCookie(COOKIE_NAME, "true", 365);
  showSecret();
});

document.getElementById("hide-again")?.addEventListener("click", () => {
  clearCookie(COOKIE_NAME);
  showDecoy();
});
