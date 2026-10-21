/* PGCC Tarbiya: connects the app to Supabase (accounts + shared data).
   Loaded after config.js and supabase-js, before the app itself. */
(function () {
  var cfg = window.PGCC_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || /YOUR-/.test(cfg.supabaseUrl + cfg.supabaseAnonKey)) {
    console.warn("PGCC: config.js is not filled in yet, running in preview mode.");
    return;
  }
  if (!window.supabase || !window.supabase.createClient) {
    console.error("PGCC: supabase-js failed to load.");
    return;
  }

  /* Remember me: keep the login in localStorage, otherwise only for this browser session */
  function remember() { try { return localStorage.getItem("pgcc-remember") !== "0"; } catch (e) { return true; } }
  var storage = {
    getItem: function (k) { try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch (e) { return null; } },
    setItem: function (k, v) {
      try {
        if (remember()) { localStorage.setItem(k, v); sessionStorage.removeItem(k); }
        else { sessionStorage.setItem(k, v); localStorage.removeItem(k); }
      } catch (e) {}
    },
    removeItem: function (k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {} }
  };

  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { storage: storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "pgcc-auth" }
  });
  window.PGCC_SB = sb;

  function friendly(err) {
    var m = (err && (err.message || err.error_description)) || "";
    var low = m.toLowerCase();
    if (low.indexOf("invalid login") > -1) return "That email and password don’t match.";
    if (low.indexOf("email not confirmed") > -1) return "Confirm your email first. Check your inbox for the link.";
    if (low.indexOf("already registered") > -1 || low.indexOf("already exists") > -1) return "An account with this email already exists. Log in instead.";
    if (low.indexOf("rate limit") > -1 || low.indexOf("too many") > -1) return "Too many attempts. Wait a minute and try again.";
    if (low.indexOf("password") > -1 && low.indexOf("least") > -1) return "Use a longer password (at least 8 characters).";
    if (low.indexOf("same") > -1 && low.indexOf("password") > -1) return "Choose a password different from your old one.";
    if (low.indexOf("fetch") > -1 || low.indexOf("network") > -1) return "No connection. Check your internet and try again.";
    return m || "Something went wrong. Try again.";
  }
  function fail(err) { throw new Error(friendly(err)); }
  function setRemember(r) { try { localStorage.setItem("pgcc-remember", r === false ? "0" : "1"); } catch (e) {} }

  var uid = null, leader = null;
  function sessionFrom(user) {
    var md = user.user_metadata || {};
    return { email: (user.email || "").toLowerCase(), name: md.name || (user.email || "").split("@")[0], id: user.id };
  }
  async function saveProfile(user) {
    try {
      var md = user.user_metadata || {};
      await sb.from("docs").upsert({ collection: "profiles", id: user.id, owner: user.id,
        data: { name: md.name || (user.email || "").split("@")[0] }, updated_at: new Date().toISOString() });
    } catch (e) {}
  }

  window.PGCC_LIVE = {
    signIn: async function (email, pw, rem) {
      setRemember(rem);
      var r = await sb.auth.signInWithPassword({ email: email, password: pw });
      if (r.error) fail(r.error);
      uid = r.data.user.id; leader = null; saveProfile(r.data.user);
      return sessionFrom(r.data.user);
    },
    signUp: async function (name, email, pw, rem) {
      setRemember(rem);
      var r = await sb.auth.signUp({ email: email, password: pw,
        options: { data: { name: name }, emailRedirectTo: location.origin + location.pathname } });
      if (r.error) fail(r.error);
      /* Supabase hides "already registered" when confirmation is on: an empty identities list means it exists */
      if (r.data.user && r.data.user.identities && r.data.user.identities.length === 0) fail({ message: "already registered" });
      if (!r.data.session) return null; /* email confirmation required */
      uid = r.data.user.id; leader = null; saveProfile(r.data.user);
      return sessionFrom(r.data.user);
    },
    reset: async function (email) {
      var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (r.error) fail(r.error);
    },
    updatePassword: async function (pw) {
      var r = await sb.auth.updateUser({ password: pw });
      if (r.error) fail(r.error);
      uid = r.data.user.id; return sessionFrom(r.data.user);
    },
    signOut: async function () { uid = null; leader = null; try { await sb.auth.signOut(); } catch (e) {} }
  };

  /* Password-reset links land back on the site: ask for a new password */
  var linkHash = location.hash + location.search;
  var fromLink = /access_token|code=|type=signup/.test(linkHash), recoveryLink = /type=recovery/.test(linkHash), sentLink = false;
  function whenLoaded(fn) { if (document.readyState === "complete") setTimeout(fn, 0); else window.addEventListener("load", function () { setTimeout(fn, 50); }); }
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "PASSWORD_RECOVERY") {
      recoveryLink = true;
      whenLoaded(function () { window.dispatchEvent(new Event("pgcc-recovery")); });
    }
    /* confirmation link from the sign-up email: log straight in */
    if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session && fromLink && !recoveryLink && !sentLink) {
      sentLink = true; saveProfile(session.user);
      var s = sessionFrom(session.user);
      whenLoaded(function () { if (!recoveryLink) window.dispatchEvent(new CustomEvent("pgcc-signedin", { detail: s })); });
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
    }
    if (event === "SIGNED_OUT") uid = null;
    if (session && session.user) uid = session.user.id;
  });

  async function currentUid() {
    if (uid) return uid;
    try { var r = await sb.auth.getSession(); if (r.data.session) { uid = r.data.session.user.id; return uid; } } catch (e) {}
    return null;
  }

  /* --- a small document store on top of the "docs" table --- */
  function parse(path) {
    var p = path.split("/");
    if (p[0] === "data" && p[1] === "users" && p[3] === "state") return { c: "state", id: p[2] };
    return { c: p[0], id: p.slice(1).join("/") };
  }
  function freeze(row) {
    return { id: row.id, exists: true, data: function () { return row.data || {}; } };
  }
  var db = {
    doc: function (path) {
      var k = parse(path);
      return {
        get: async function () {
          var r = await sb.from("docs").select("id,data").eq("collection", k.c).eq("id", k.id).maybeSingle();
          if (r.error) throw r.error;
          return r.data ? freeze(r.data) : { id: k.id, exists: false, data: function () { return undefined; } };
        },
        set: async function (data) {
          var me = await currentUid();
          var row = { collection: k.c, id: k.id, data: data, updated_at: new Date().toISOString() };
          /* the owner column records who wrote it; for leader-written docs keep it as the leader */
          row.owner = me;
          var r = await sb.from("docs").upsert(row, { onConflict: "collection,id" });
          if (r.error) throw r.error;
        }
      };
    },
    collection: function (c) {
      return {
        onSnapshot: function (next, error) {
          var alive = true, timer = null, chan = null, busy = false, again = false;
          async function pull() {
            if (!alive) return;
            if (busy) { again = true; return; }
            busy = true;
            try {
              var r = await sb.from("docs").select("id,data").eq("collection", c);
              if (r.error) throw r.error;
              if (alive) next({ docs: (r.data || []).map(freeze) });
            } catch (e) { if (alive && error) error(e); }
            busy = false;
            if (again) { again = false; pull(); }
          }
          pull();
          try {
            chan = sb.channel("docs-" + c + "-" + Math.random().toString(36).slice(2))
              .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "collection=eq." + c }, function () { pull(); })
              .subscribe();
          } catch (e) {}
          timer = setInterval(pull, 30000);
          function vis() { if (document.visibilityState === "visible") pull(); }
          document.addEventListener("visibilitychange", vis);
          return function () {
            alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", vis);
            try { if (chan) sb.removeChannel(chan); } catch (e) {}
          };
        }
      };
    }
  };

  var user = {
    id: currentUid,
    isOwner: function () { return !!leader; },
    profiles: async function (ids) {
      var out = {};
      ids = (ids || []).filter(Boolean);
      if (!ids.length) return out;
      try {
        var r = await sb.from("docs").select("id,data").eq("collection", "profiles").in("id", ids);
        (r.data || []).forEach(function (row) { out[row.id] = row.data || {}; });
      } catch (e) {}
      return out;
    }
  };

  window.claude = {
    use: async function (what) {
      if (what === "db") return (await currentUid()) ? db : null;
      if (what === "user") {
        var me = await currentUid();
        if (!me) return user;
        if (leader === null) {
          try { var r = await sb.rpc("is_leader"); leader = !r.error && r.data === true; } catch (e) { leader = false; }
        }
        return user;
      }
      return null;
    }
  };
})();
