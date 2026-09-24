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
 */
(function () {
  'use strict'

  var form = document.querySelector('form[action="/app/attendance/checkin"]')
  if (!form) return

  var latInput = form.querySelector('input[name="lat"]')
  var lngInput = form.querySelector('input[name="lng"]')
  if (!latInput || !lngInput) return

  var latest = null

  function setFields(pos) {
    latest = { lat: pos.coords.latitude, lng: pos.coords.longitude }
    latInput.value = String(latest.lat)
    lngInput.value = String(latest.lng)
  }

  function clearFields() {
    latest = null
    latInput.value = ''
    lngInput.value = ''
  }

  function isGarbage(p) {
    return !p || p.lat === 0 || p.lng === 0 ||
      Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 ||
      typeof p.lat !== 'number' || typeof p.lng !== 'number'
  }

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      function (pos) { if (!isGarbage({ lat: pos.coords.latitude, lng: pos.coords.longitude })) setFields(pos) },
      function () { clearFields() },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    )
  }

  form.addEventListener('submit', function () {
    if (latest && !isGarbage(latest)) {
      // Refresh at the moment of the press (DECISIONS 31.3: the capture is
      // this press, not the page load). Fire-and-forget: if the device
      // answers after the form is already gone, the post carries what it
      // had and the row says so.
      navigator.geolocation.getCurrentPosition(setFields, clearFields, {
        enableHighAccuracy: true, timeout: 4000, maximumAge: 5000,
      })
    }
    // Empty or garbage fields are left as they are: the server stores
    // NULL/unavailable and the attendance stands.
  })
})()
