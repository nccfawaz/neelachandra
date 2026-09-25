/*
 * The site check-in panel's geolocation capture (DECISIONS 31).
 *
 * This file obeys the same rule as attendance-grid.js: A CLIENT FILE MOVES
 * FOCUS AND COUNTS. IT DOES NOT KNOW A BUSINESS RULE. Nothing here computes
 * distance, decides what "far" means, or judges whether a reading is good
 * enough -- the server does all of that. What this file does is the one thing
 * only the browser can do: ask the device for its position and put the answer
 * in the form fields the server rendered.
 *
 * The first version of the panel shipped static hidden inputs and no script,
 * so every post carried empty lat/lng -- which the service then recorded as
 * 0,0, a plausible-looking coordinate that is actually the ocean off Ghana.
 * The server now treats an empty or invalid reading as "unavailable" and
 * stores NULL; this script is what makes the common case carry a real
 * position instead.
 *
 * Behaviour:
 *
 *   - Asked on page load, once. The prompt is the browser's own; denying it
 *     is fine -- the fields stay empty, the server stores NULL/unavailable,
 *     and the attendance stands (DECISIONS 31.1).
 *   - Written into the hidden inputs just before submit, not continuously.
 *     DECISIONS 31.3: location is captured at check-in and check-out only.
 *     A position fetched at page load could be minutes stale by the time the
 *     worker presses the button, so the fields are refreshed on submit -- and
 *     if the reading arrives after the form has gone, the post simply carries
 *     the stale-empty value and the row says unavailable. Honesty beats
 *     latency.
 *   - (0, 0) is never submitted. A failed GPS can serialise to exactly zero
 *     on both axes; the server would store NULL for it anyway, but the
 *     client does not send known-garbage.
 *
 * Execution order (hardened after a production report where the fields
 * never filled despite the form being in the DOM): the tag arrives with
 * `defer` in <head> (AppShell), which usually runs after parsing -- but the
 * first version queried the DOM immediately and exited silently when it
 * missed. Now the DOM walk waits for DOMContentLoaded, the submit hook is a
 * DELEGATED listener on document (so it survives the form being re-rendered
 * by a future htmx swap), and a short retry covers any host that strips or
 * reorders the defer. A missed form logs a console warning instead of
 * vanishing.
 */
(function () {
  'use strict'

  var FORM_SELECTOR = 'form[action="/app/attendance/checkin"]'

  var latInput = null
  var lngInput = null
  var latest = null
  var bound = false

  function isGarbage(p) {
    return !p || p.lat === 0 || p.lng === 0 ||
      Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 ||
      typeof p.lat !== 'number' || typeof p.lng !== 'number'
  }

  function setFields(pos) {
    latest = { lat: pos.coords.latitude, lng: pos.coords.longitude }
    if (latInput) latInput.value = String(latest.lat)
    if (lngInput) lngInput.value = String(latest.lng)
  }

  function clearFields() {
    latest = null
    if (latInput) latInput.value = ''
    if (lngInput) lngInput.value = ''
  }

  function askForPosition(timeoutMs) {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        if (!isGarbage({ lat: pos.coords.latitude, lng: pos.coords.longitude })) setFields(pos)
      },
      function () { clearFields() },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    )
  }

  function bind(form) {
    if (bound) return
    latInput = form.querySelector('input[name="lat"]')
    lngInput = form.querySelector('input[name="lng"]')
    if (!latInput || !lngInput) {
      console.warn('[checkin-geo] form found but lat/lng inputs missing')
      return
    }
    bound = true
    // Delegated on document, not on the form node: an htmx swap that
    // replaces the panel must not silently unhook the submit hook.
    document.addEventListener('submit', function (e) {
      var target = e.target
      if (!target || target !== form || !target.matches(FORM_SELECTOR)) return
      if (latest && !isGarbage(latest)) {
        // Refresh at the moment of the press (DECISIONS 31.3: the capture
        // is this press, not the page load). Fire-and-forget: if the device
        // answers after the form is already gone, the post carries what it
        // had and the row says so.
        navigator.geolocation.getCurrentPosition(setFields, clearFields, {
          enableHighAccuracy: true, timeout: 4000, maximumAge: 5000,
        })
      }
      // Empty or garbage fields are left as they are: the server stores
      // NULL/unavailable and the attendance stands.
    })
    askForPosition(10000)
  }

  function tryBind() {
    var form = document.querySelector(FORM_SELECTOR)
    if (form) { bind(form); return true }
    return false
  }

  function start() {
    if (tryBind()) return
    // The form is server-rendered into the initial HTML, so by
    // DOMContentLoaded it must exist. If it does not, give the page one
    // short beat (slow device / stripped defer / late host rewrite) before
    // declaring the miss loudly rather than silently.
    var tries = 0
    var timer = setInterval(function () {
      if (tryBind() || ++tries >= 10) {
        clearInterval(timer)
        if (!bound) {
          console.warn('[checkin-geo] check-in form not found after load; ' +
            'geolocation capture disabled for this page')
        }
      }
    }, 300)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
