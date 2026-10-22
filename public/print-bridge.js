/*
 * Label printing for pages that are plain HTML (the label preview page, /api/labels?...). It does the same as
 * lib/print-bridge.ts: QZ Tray first, then the print helper (scripts/print_bridge.py) only when QZ Tray cannot be
 * reached. Keep the two in step when you change one (printer name, QZ version, rules).
 *
 *   window.sendLabelsToPrinter(tspl)  ->  Promise resolving with the number of labels printed
 */
(function () {
  var HELPER_URL = "ws://localhost:8767";
  var HELPER_DOWN =
    "The print helper is not running on this computer. Ask whoever manages this PC to run the print helper installer (scripts/print-helper), or restart the PC if it was installed already.";
  var PRINTER_MATCH = "Xprinter_XP_365B";
  var QZ_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js";
  var QZ_CONNECT_TIMEOUT_MS = 60000;
  var QZ_RETRY_AFTER_MS = 30000;

  var qzScript = null;
  var qzDownUntil = 0;
  var signingConfigured = false;

  function QzPrintError(message) {
    this.name = "QzPrintError";
    this.message = message;
  }
  QzPrintError.prototype = Object.create(Error.prototype);

  function errorText(err) {
    return err && err.message ? err.message : String(err);
  }

  function normalise(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error(message));
      }, ms);
      promise.then(
        function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        function (err) {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  function loadQz() {
    if (window.qz) return Promise.resolve(window.qz);
    if (!qzScript) {
      qzScript = new Promise(function (resolve, reject) {
        var tag = document.createElement("script");
        tag.src = QZ_SCRIPT_URL;
        tag.async = true;
        tag.onload = function () {
          if (window.qz) resolve(window.qz);
          else reject(new Error("The QZ Tray library did not load"));
        };
        tag.onerror = function () {
          reject(new Error("The QZ Tray library could not be downloaded"));
        };
        document.head.appendChild(tag);
      }).catch(function (err) {
        qzScript = null;
        throw err;
      });
    }
    return qzScript;
  }

  function setupSigning(qz) {
    if (signingConfigured) return;
    signingConfigured = true;
    qz.security.setSignatureAlgorithm("SHA512");
    qz.security.setCertificatePromise(function (resolve, reject) {
      fetch("/api/qz/certificate", { cache: "no-store", credentials: "same-origin" })
        .then(function (res) {
          return res.ok ? res.text() : Promise.reject(new Error("No QZ certificate"));
        })
        .then(resolve, reject);
    });
    qz.security.setSignaturePromise(function (toSign) {
      return function (resolve, reject) {
        fetch("/api/qz/sign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          credentials: "same-origin",
          body: JSON.stringify({ request: toSign }),
        })
          .then(function (res) {
            return res.ok ? res.text() : Promise.reject(new Error("Could not sign the QZ request"));
          })
          .then(resolve, reject);
      };
    });
  }

  function connectQz() {
    return loadQz().then(function (qz) {
      setupSigning(qz);
      if (qz.websocket.isActive()) return qz;
      return withTimeout(
        qz.websocket.connect({ retries: 0, delay: 0, usingSecure: true }),
        QZ_CONNECT_TIMEOUT_MS,
        "QZ Tray did not answer"
      ).then(function () {
        return qz;
      });
    });
  }

  function sendToQz(qz, tspl) {
    return qz.printers
      .find()
      .then(function (found) {
        var printers = Array.isArray(found) ? found : [found];
        var wanted = normalise(PRINTER_MATCH);
        var matches = printers.filter(function (name) {
          return normalise(name).indexOf(wanted) !== -1;
        });
        if (matches.length === 0) {
          throw new Error(
            'QZ Tray is running but no printer named like "' + PRINTER_MATCH + '" was found. Check that the label printer is plugged in and switched on.'
          );
        }
        if (matches.length === 1) return matches[0];
        // Several queues for the same printer: the PC's default one is the one set up for raw label commands.
        return qz.printers.getDefault().then(
          function (fallback) {
            return matches.indexOf(fallback) !== -1 ? fallback : matches[0];
          },
          function () {
            return matches[0];
          }
        );
      })
      .then(function (printer) {
        // forceRaw (altPrinting before QZ 2.2) stops macOS/Linux printing the commands as text.
        var config = qz.configs.create(printer, { forceRaw: true, altPrinting: true });
        return qz.print(config, [{ type: "raw", format: "command", flavor: "plain", data: tspl }]);
      })
      .then(function () {
        var count = tspl.match(/^\s*PRINT\b/gim);
        return count ? count.length : 0;
      })
      .catch(function (err) {
        throw new QzPrintError("Printing through QZ Tray failed: " + errorText(err));
      });
  }

  function sendToHelper(tspl) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var socket = null;
      var timer = setTimeout(function () {
        finish(new Error("The print helper did not answer. Check the printer and try again."));
      }, 15000);
      function finish(err, labels) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          if (socket) socket.close();
        } catch {}
        if (err) reject(err);
        else resolve(labels || 0);
      }
      try {
        socket = new WebSocket(HELPER_URL);
      } catch {
        finish(new Error(HELPER_DOWN));
        return;
      }
      socket.onopen = function () {
        socket.send(JSON.stringify({ type: "print", tspl: tspl }));
      };
      socket.onerror = function () {
        finish(new Error(HELPER_DOWN));
      };
      socket.onclose = function () {
        finish(new Error(HELPER_DOWN));
      };
      socket.onmessage = function (event) {
        try {
          var reply = JSON.parse(String(event.data));
          if (reply.type === "printed") finish(null, reply.labels);
          else finish(new Error(reply.message || "Printing failed"));
        } catch {
          finish(new Error("The print helper gave an answer that could not be read"));
        }
      };
    });
  }

  window.sendLabelsToPrinter = function (tspl) {
    var qzReason = "";
    var tryQz =
      Date.now() >= qzDownUntil
        ? connectQz().then(
            function (qz) {
              return { qz: qz };
            },
            function (err) {
              qzDownUntil = Date.now() + QZ_RETRY_AFTER_MS;
              qzReason = errorText(err);
              return { qz: null };
            }
          )
        : Promise.resolve({ qz: null });

    return tryQz.then(function (result) {
      // QZ Tray is reachable: its result is final, printed or failed. No retry on the helper (no double labels).
      if (result.qz) return sendToQz(result.qz, tspl);
      if (!qzReason) qzReason = "QZ Tray was not reachable a moment ago";
      return sendToHelper(tspl).catch(function (err) {
        throw new Error("QZ Tray is not available (" + qzReason + ") and the print helper failed: " + errorText(err));
      });
    });
  };
})();
