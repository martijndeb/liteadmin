export const Api = {
  csrf: '',
  app: { name: 'LiteAdmin', lang: 'en', max_rows: 1000, buffer_rows: 200 },

  async call(url, body, raw = false) {
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf },
      body: JSON.stringify(body),
    });
    if (raw) {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      return r;
    }
    const data = await r.json().catch(() => ({ ok: false, error: 'Bad response' }));
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data;
  },

  async session() {
    const d = await this.call('index.php?action=session', { action: 'session' });
    this.csrf = d.csrf || '';
    this.app = d.app || this.app;
    this.configWritable = !!d.config_writable;
    this.needsSetup = !!d.needs_setup;
    this.canCreateDb = !!d.can_create_db;
    return d;
  },

  async login(username, password) {
    const d = await this.call('index.php?action=login', { action: 'login', username, password });
    this.csrf = d.csrf;
    return d;
  },

  async setup(password) {
    const d = await this.call('index.php?action=setup', { action: 'setup', password });
    this.csrf = d.csrf;
    this.needsSetup = false;
    return d;
  },

  async changePassword(current, newPassword) {
    return this.call('index.php?action=change_password', { action: 'change_password', current, new: newPassword });
  },

  async logout() { await this.call('index.php?action=logout', { action: 'logout' }); this.csrf = ''; },

  proxy(action, params = {}) { return this.call('proxy.php', { action, ...params }); },

  async backupBlob(db) {
    const r = await this.call('proxy.php', { action: 'backup', db }, true);
    return r.blob();
  },
};
