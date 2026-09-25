/*
 * The site check-in panel's geolocation capture (DECISIONS 31).
 *
 * This file obeys the same rule as attendance-grid.js: A CLIENT FILE MOVES
 * FOCUS AND COUNTS. IT DOES NOT KNOW A BUSINESS RULE. Nothing here computes
 * distance, decides what "far" means, or judges whether a reading is good
 * enough -- the server does all of that. What this file does is the one thing
 * only the browser can do: ask the device for its position at the moment the
 * button is pressed and put the answer in the form fields the server
 * rendered.
 *
 * Behaviour (DECISIONS 31.13, capture at the press):
 *
 *   - The button press is intercepted, the button is disabled and shows
 *     "Getting your location…", and ONE getCurrentPosition runs with
 *     enableHighAccuracy and a 10 s timeout.
 *   - Success: fields are filled and the form submits.
 *   - Timeout or denial: the form submits anyway with empty fields. The
 *     server stores NULL, the row says unavailable, and the attendance
 *     stands (DECISIONS 31.1) -- attendance is never refused on location.
 *   - The button stays disabled until the submit leaves, so a double press
 *     cannot fire two posts.
 *
 * Execution order: the tag arrives with `defer` in <head> (AppShell), so the
 * DOM walk waits for DOMContentLoaded and the submit hook is a DELEGATED
 * listener on document -- a missed form retries for ~3 s and then logs a
 * [checkin-geo] warning instead of vanishing silently.
 *
 * A no-JavaScript browser is untouched: the intercept only exists when this
 * script runs, so the plain form post still works and simply carries empty
 * fields.
 */
(function () {
  'use strict'

  var FORM_SELECTOR = 'form[action="/app/attendance/checkin"]'

  var bound = false

  function isGarbage(p) {
    return !p || p.lat === 0 || p.lng === 0 ||
      Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 ||
      typeof p.lat !== 'number' || typeof p.lng !== 'number'
  }

  function bind(form) {
    if (bound) return
    var latInput = form.querySelector('input[name="lat"]')
    var lngInput = form.querySelector('input[name="lng"]')
    var button = form.querySelector('.ncc-checkin-btn')
    if (!latInput || !lngInput || !button) {
      console.warn('[checkin-geo] form found but lat/lng inputs or button missing')
      return
    }
    bound = true

    // Delegated on document, not on the form node: an htmx swap that
    // replaces the panel must not silently unhook the submit hook.
    document.addEventListener('submit', function (e) {
      var target = e.target
      if (!target || target !== form || !target.matches(FORM_SELECTOR)) return

      // No geolocation at all (very old browser): let the plain post go
      // through with empty fields -- the server stores NULL/unavailable.
      if (!navigator.geolocation) return

      // The capture is this press (DECISIONS 31.3), not the page load:
      // intercept, disable, ask, then submit with whatever arrived.
      e.preventDefault()
      button.disabled = true
      button.textContent = 'Getting your location…'

      var settled = false
      function go() {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        form.submit() // bypasses the intercept: this IS the submit
      }

      // Our own deadline, not just the API's timeout option: a device or
      // wrapper that never calls back must not leave the button disabled
      // forever. The worker submits with empty fields instead.
      var deadline = setTimeout(go, 10500)

      navigator.geolocation.getCurrentPosition(
        function (pos) {
          var reading = { lat: pos.coords.latitude, lng: pos.coords.longitude }
          if (!isGarbage(reading)) {
            latInput.value = String(reading.lat)
            lngInput.value = String(reading.lng)
          }
          go()
        },
        function () {
          // Denial or timeout: submit anyway with empty fields. The server
          // stores NULL and the row says unavailable; attendance stands.
          go()
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      )
    })
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
