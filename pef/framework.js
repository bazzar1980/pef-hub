/*
 * PEF Hub - reference framework.js for the Genesys Cloud Embeddable Framework.
 *
 * MERGE this message contract into your existing framework.js (keep your clientIds/settings).
 * The PEF iframe talks ONLY to its parent (the PEF Hub window); the hub routes to the CRMs.
 *
 *   PEF -> hub (window.parent.postMessage, JSON string {type, data}):
 *     screenPop, processCallLog, openCallLog, contactSearch,
 *     interactionSubscription, userActionSubscription, notificationSubscription, pefReady
 *   hub -> PEF (window message):
 *     clickToDial, contactSearchResult, addAssociation
 */
(function () {
  var HUB_ORIGINS = ["https://tauri.localhost", "https://localhost:1420"]; // prod + dev hub window
  var pending = {};
  var seq = 0;

  function post(type, data) {
    window.parent.postMessage(JSON.stringify({ type: type, data: data }), "*");
  }

  window.Framework = {
    config: {
      name: "pefHub",
      clientIds: { "mypurecloud.ie": "<YOUR_OAUTH_CLIENT_ID>" },
      settings: {
        embedWebRTCByDefault: true,
        enableCallLogs: true,
        dedicatedLoginWindow: false,
        embeddedInteractionWindow: true,
        searchTargets: ["people", "queues", "frameworkcontacts"]
      }
    },

    initialSetup: function () {
      window.PureCloud.subscribe([
        { type: "Interaction", callback: function (category, interaction) { post("interactionSubscription", { category: category, interaction: interaction }); } },
        { type: "UserAction", callback: function (category, data) { post("userActionSubscription", { category: category, data: data }); } },
        { type: "Notification", callback: function (category, data) { post("notificationSubscription", { category: category, data: data }); } }
      ]);

      window.addEventListener("message", function (event) {
        if (HUB_ORIGINS.indexOf(event.origin) === -1) return;
        var msg;
        try { msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch (e) { return; }
        if (!msg || !msg.type) return;

        if (msg.type === "clickToDial") {
          window.PureCloud.clickToDial(msg.data);
        } else if (msg.type === "contactSearchResult") {
          var p = pending[msg.data.requestId];
          if (p) { clearTimeout(p.timer); delete pending[msg.data.requestId]; p.onSuccess(msg.data.results || []); }
        } else if (msg.type === "addAssociation") {
          window.PureCloud.addAssociation(msg.data);
        }
      });

      post("pefReady", {});
    },

    screenPop: function (searchString, interaction) {
      post("screenPop", { searchString: searchString, interaction: interaction });
    },

    processCallLog: function (callLog, interaction, eventName, onSuccess, onFailure) {
      post("processCallLog", { callLog: callLog, interaction: interaction, eventName: eventName });
      onSuccess({ id: callLog.id || interaction.id });
    },

    openCallLog: function (callLog, interaction) {
      post("openCallLog", { callLog: callLog, interaction: interaction });
    },

    // Fan-out to every connected CRM, merged by the hub (hub timeout 2.5s, safety net 4s here).
    contactSearch: function (searchString, onSuccess, onFailure) {
      var id = "cs-" + Date.now() + "-" + (++seq);
      pending[id] = {
        onSuccess: onSuccess,
        timer: setTimeout(function () { delete pending[id]; onSuccess([]); }, 4000)
      };
      post("contactSearch", { requestId: id, searchString: searchString });
    }
  };
})();
