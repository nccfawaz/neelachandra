/*
 * The attendance month matrix's keyboard layer (spec 1761, DECISIONS 17.2).
 *
 * THE FIRST CLIENT COMPONENT IN THIS REPOSITORY, so read the rules before
 * copying it. There is no bundler and no type checking on this directory --
 * `tsconfig.json` excludes `public/` and `vite build` only minifies the
 * dashboard stylesheet -- which means everything below is unverified by every
 * gate the rest of the tree passes. That is the whole reason for the one rule
 * this file obeys:
 *
 *   A CLIENT FILE MOVES FOCUS AND COUNTS. IT DOES NOT KNOW A BUSINESS RULE.
 *
 * Nothing here knows what an attendance status is, which statuses a cell may
 * take, which cells are editable, when a month is closed, or what a keystroke
 * means. Every one of those is decided on the server and reaches this file as
 * markup: the keystroke table arrives as one JSON attribute the server rendered
 * from src/modules/hr/schemas.ts, and the set of statuses a cell will accept is
 * the set of <option> elements the server put in it. So a keystroke for a
 * status the server did not offer on that cell finds no option and does
 * nothing. The client cannot offer a combination the database would refuse,
 * because it does not compose combinations at all -- it selects from what was
 * sent.
 *
 * The corollary is that this file has no idea what changed. Every editable cell
 * posts its current value on submit, changed or not, and the server compares
 * each against the stored row. `dirty` below is a number in a button label; it
 * decides nothing. Do not "optimise" the post down to the changed cells: the
 * shape would survive it (each option carries its own employee and day) but the
 * property that a JavaScript-off browser and this one write identically would
 * not, and that property is the reason the fallback is trustworthy.
 */
;(function () {
  'use strict'

  function register(Alpine) {
    Alpine.data('attendanceGrid', function () {
      return {
        /** Cells whose value differs from what the page was rendered with. Display only. */
        dirty: 0,
        /** { letter: status }, rendered by the server. Empty means no shortcuts, not no entry. */
        keys: {},
        submitting: false,
        guard: null,

        init: function () {
          var self = this
          try {
            this.keys = JSON.parse(this.$el.dataset.keymap || '{}')
          } catch (err) {
            this.keys = {}
          }

          // What the server sent, captured before anybody can change it. This is
          // the only "previous value" this file has, and it is used for the
          // dirty count and for the revert key -- never to decide what to post.
          this.cells().forEach(function (select) {
            select.dataset.stored = select.value
          })

          this.guard = function (event) {
            if (self.dirty > 0 && !self.submitting) event.preventDefault()
          }
          window.addEventListener('beforeunload', this.guard)
        },

        destroy: function () {
          if (this.guard) window.removeEventListener('beforeunload', this.guard)
        },

        cells: function () {
          return Array.prototype.slice.call(this.$el.querySelectorAll('select[name="cell"]'))
        },

        summary: function () {
          if (this.dirty === 0) return ''
          return ' · ' + this.dirty + (this.dirty === 1 ? ' cell changed' : ' cells changed')
        },

        recount: function () {
          var n = 0
          this.cells().forEach(function (select) {
            var changed = select.value !== select.dataset.stored
            select.classList.toggle('is-dirty', changed)
            if (changed) n += 1
          })
          this.dirty = n
        },

        onChange: function (event) {
          if (event.target && event.target.name === 'cell') this.recount()
        },

        onSubmit: function () {
          this.submitting = true
        },

        onKey: function (event) {
          var select = event.target
          if (!select || select.name !== 'cell') return
          // Alt+Down is the browser's own "open the dropdown" and the modifiers
          // belong to the browser and the OS. Space opens it too, so it is let
          // through below rather than swallowed with the other printable keys.
          if (event.altKey || event.ctrlKey || event.metaKey) return

          var key = event.key
          if (key === ' ') return

          if (key === 'ArrowRight' || key === 'ArrowLeft' || key === 'ArrowUp' || key === 'ArrowDown') {
            // Swallowing arrows is not a preference. On a closed <select> the
            // browser's own handling of Up and Down changes the selected option,
            // so a supervisor arrowing across a month would silently rewrite
            // every cell they passed through. In a grid an arrow moves.
            event.preventDefault()
            this.move(select, key)
            return
          }

          if (key === 'Enter') {
            // Down, like a spreadsheet -- and never a submit. Enter on a control
            // inside a form submits it by default, which on a 300-cell grid is a
            // month posted by a typo. The button is the only way to submit.
            event.preventDefault()
            this.move(select, event.shiftKey ? 'ArrowUp' : 'ArrowDown')
            return
          }

          if (key === 'Home' || key === 'End') {
            event.preventDefault()
            var row = select.closest('tr')
            var inRow = row ? row.querySelectorAll('select[name="cell"]') : []
            var edge = key === 'Home' ? inRow[0] : inRow[inRow.length - 1]
            if (edge) edge.focus()
            return
          }

          if (key === 'Backspace' || key === 'Delete') {
            // Revert to what the server sent, which is the honest meaning of
            // "clear" here: this screen cannot delete an attendance row, so
            // showing an emptied cell over a stored status would be a lie.
            event.preventDefault()
            select.value = select.dataset.stored
            this.recount()
            return
          }

          if (key.length !== 1) return

          // Every printable key is swallowed, including one with no status
          // behind it. Left to the browser it would run the native <select>
          // type-ahead, which jumps to whichever option's label happens to start
          // with that letter -- a different cell value from a different key on a
          // different browser. Deterministic beats convenient.
          event.preventDefault()
          var status = this.keys[key.toLowerCase()]
          if (!status) return
          var option = this.option(select, status)
          if (!option) return
          select.value = option.value
          this.recount()
        },

        /** The option for a status, or null when this cell was not offered it. */
        option: function (select, status) {
          for (var i = 0; i < select.options.length; i += 1) {
            var value = select.options[i].value
            if (value.slice(value.lastIndexOf('|') + 1) === status) return select.options[i]
          }
          return null
        },

        /**
         * One step in a direction, skipping cells that carry no control.
         *
         * Coordinates come from the table itself -- rowIndex and cellIndex -- so
         * the server renders no position attributes and the two cannot disagree.
         * A cell with no control is a day outside somebody's employment, already
         * approved, or still in the future, and stepping over it is right: the
         * cursor should not stop where nothing can be typed.
         */
        move: function (select, key) {
          var cell = select.closest('td')
          var row = cell && cell.parentElement
          var table = row && row.closest('table')
          if (!table) return

          var dr = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0
          var dc = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0
          var r = row.rowIndex
          var c = cell.cellIndex

          // Terminates on the edge of the table; the counter is a stop in case a
          // future markup change breaks that assumption.
          for (var steps = 0; steps < 1000; steps += 1) {
            r += dr
            c += dc
            var nextRow = table.rows[r]
            if (!nextRow) return
            var nextCell = nextRow.cells[c]
            if (!nextCell) return
            var target = nextCell.querySelector('select[name="cell"]')
            if (target) {
              target.focus()
              return
            }
          }
        },
      }
    })
  }

  // Alpine is loaded with `defer` and started on DOMContentLoaded, and every
  // deferred script runs before that event, so the listener is always in place
  // in time. The direct branch covers a future page that loads Alpine earlier.
  if (window.Alpine) {
    register(window.Alpine)
  } else {
    document.addEventListener('alpine:init', function () {
      register(window.Alpine)
    })
  }
})()
