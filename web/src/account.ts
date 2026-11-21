import { html, nothing } from "lit";
import { LightElement, errorText } from "@corestone/ui";
import { customElement, state } from "lit/decorators.js";
import { api, type Account } from "./api";
import { store, type State } from "./store";
import { themeChoice } from "./components/theme-choice";

// Local accounts (-auth local): the sign-in page shown instead of the
// application, and the account dialog behind the header's user button.

const formValues = (form: HTMLFormElement) =>
  Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v)])) as Record<string, string>;

/** Signing in, or creating the first account (which becomes admin) on a new server. */
@customElement("corestone-signin")
export class SignIn extends LightElement {
  /** No account exists yet: create the first one instead of signing in. */
  setup = false;
  @state() private error = "";
  @state() private busy = false;

  private submit = async (e: Event) => {
    e.preventDefault();
    const v = formValues(e.target as HTMLFormElement);
    if (this.setup && v.password !== v.repeat) { this.error = "The passwords differ."; return; }
    this.busy = true;
    this.error = "";
    try {
      if (this.setup) await api.setup(v.name.trim(), v.email.trim(), v.password);
      else await api.login(v.email.trim(), v.password);
      location.reload();
    } catch (err) {
      this.error = errorText(err);
      this.busy = false;
    }
  };

  override render() {
    return html`<div class="signin">
      <form class="signin-card" data-test="signin" @submit=${this.submit}>
        <div class="brand"><span class="logo"></span>Corestone</div>
        <h2>${this.setup ? "Create the first account" : "Sign in"}</h2>
        ${this.setup ? html`<p class="hint">This server has no accounts yet. The first account is an admin and can create the others.</p>` : nothing}
        ${this.setup ? html`<label>Name<input type="text" name="name" required autocomplete="name"></label>` : nothing}
        <label>Email<input type="email" name="email" required autocomplete="username" autofocus></label>
        <label>Password<input type="password" name="password" required autocomplete=${this.setup ? "new-password" : "current-password"}></label>
        ${this.setup ? html`<label>Repeat password<input type="password" name="repeat" required autocomplete="new-password"></label>` : nothing}
        ${this.error ? html`<div class="notice error" data-test="signin-error">${this.error}</div>` : nothing}
        <button type="submit" class="btn primary" ?disabled=${this.busy}>${this.setup ? "Create account" : "Sign in"}</button>
      </form>
    </div>`;
  }
}

/** The own account (name, email, password, theme, sign out); admins also manage all accounts. */
@customElement("corestone-account-dialog")
export class AccountDialog extends LightElement {
  @state() private s!: State;
  @state() private manage = false;
  @state() private accounts: Account[] = [];
  @state() private unknownAdmins: string[] = [];
  @state() private resetting: string | null = null; // the account whose new password is being typed
  @state() private deleting: string | null = null; // the account whose deletion awaits confirmation
  @state() private error = "";
  private unsub?: () => void;

  override connectedCallback() { super.connectedCallback(); this.unsub = store.subscribe((s) => (this.s = s)); }
  override disconnectedCallback() { this.unsub?.(); super.disconnectedCallback(); }

  /** Runs a change, showing a failure inline; resolves whether it worked. */
  private async run(fn: () => Promise<unknown>, done: string): Promise<boolean> {
    this.error = "";
    try {
      await fn();
      store.toast(done, "success");
      return true;
    } catch (e) {
      this.error = errorText(e);
      return false;
    }
  }

  private saveProfile = async (e: Event) => {
    e.preventDefault();
    const v = formValues(e.target as HTMLFormElement);
    await this.run(async () => {
      const a = await api.updateMe(v.name.trim(), v.email.trim());
      store.setAccount(a);
      if (this.manage) await this.load();
    }, "Account saved");
  };

  private changePassword = async (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const v = formValues(form);
    if (v.password !== v.repeat) { this.error = "The new passwords differ."; return; }
    if (await this.run(() => api.changePassword(v.current, v.password), "Password changed")) form.reset();
  };

  private signOut = async () => {
    try { await api.logout(); } catch { /* the session ends either way */ }
    location.reload();
  };

  private async load() {
    try {
      const r = await api.accounts();
      this.accounts = r.accounts;
      this.unknownAdmins = r.unknownAdmins;
    } catch (e) { this.error = errorText(e); }
  }

  private toggleManage = () => {
    this.manage = !this.manage;
    if (this.manage) void this.load();
  };

  private createAccount = async (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const v = formValues(form);
    const role = v.role === "admin" ? "admin" : "user";
    if (await this.run(() => api.createAccount({ name: v.name.trim(), email: v.email.trim(), password: v.password, role }), `Account ${v.name.trim()} created`)) {
      form.reset();
      await this.load();
    }
  };

  private resetPassword = async (e: Event, a: Account) => {
    e.preventDefault();
    const v = formValues(e.target as HTMLFormElement);
    if (await this.run(() => api.resetPassword(a.guid, v.password), `Password of ${a.name} reset`)) this.resetting = null;
  };

  /** Roles live in the repository: each change is a commit to .corestone/access.json. */
  private setRole = async (a: Account, role: "user" | "admin") => {
    if (await this.run(() => api.setRole(a.guid, role), role === "admin" ? `${a.name} is now admin` : `${a.name} is no longer admin`)) {
      await this.load();
      if (a.guid === this.s.account?.guid) store.setAccount({ ...this.s.account, role });
    }
  };

  private deleteAccount = async (a: Account) => {
    if (await this.run(() => api.deleteAccount(a.guid), `Account ${a.name} deleted`)) {
      this.deleting = null;
      await this.load();
    }
  };

  /** The row's actions: reset the password or delete (with confirmation); never your own deletion. */
  private rowActions(a: Account, me: Account) {
    if (this.resetting === a.guid) {
      return html`<form class="inline-form" @submit=${(e: Event) => this.resetPassword(e, a)}>
        <input type="password" name="password" required placeholder="New password" aria-label=${`New password for ${a.name}`} autocomplete="new-password">
        <button type="submit" class="btn sm primary">Set</button><button type="button" class="btn sm" @click=${() => (this.resetting = null)}>Cancel</button></form>`;
    }
    if (this.deleting === a.guid) {
      return html`<span class="inline-form"><span class="small">Delete ${a.name}?</span>
        <button class="btn sm danger" data-test="confirm-delete" @click=${() => this.deleteAccount(a)}>Delete</button>
        <button class="btn sm" @click=${() => (this.deleting = null)}>Cancel</button></span>`;
    }
    return html`<span class="inline-form">
      <button class="btn sm" data-test="reset-password" @click=${() => { this.error = ""; this.deleting = null; this.resetting = a.guid; }}>Reset password</button>
      ${a.guid === me.guid ? nothing : html`<button class="btn sm delete-x" data-test="delete-account" title="Delete" aria-label=${`Delete ${a.name}`}
        @click=${() => { this.error = ""; this.resetting = null; this.deleting = a.guid; }}>✕</button>`}</span>`;
  }

  private manageView(me: Account) {
    return html`<section class="account-section" data-test="manage-accounts">
      <h3>Accounts</h3>
      <table class="accounts">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
        <tbody>${this.accounts.map((a) => html`<tr data-test="account-row" data-email=${a.email}>
          <td>${a.name}${a.guid === me.guid ? html` <span class="muted small">(you)</span>` : nothing}</td><td>${a.email}</td>
          <td><button class="btn sm" data-test="toggle-role" title=${a.role === "admin" ? "Withdraw the admin role (commits .corestone/access.json)" : "Grant the admin role (commits .corestone/access.json)"}
            @click=${() => this.setRole(a, a.role === "admin" ? "user" : "admin")}>${a.role}</button></td>
          <td>${this.rowActions(a, me)}</td>
        </tr>`)}</tbody>
      </table>
      ${this.unknownAdmins.length ? html`<div class="notice" data-test="unknown-admins">.corestone/access.json names admins without an account: ${this.unknownAdmins.join(", ")}</div>` : nothing}
      <h3>New account</h3>
      <form class="account-form" data-test="new-account" @submit=${this.createAccount}>
        <label>Name<input type="text" name="name" required></label>
        <label>Email<input type="email" name="email" required></label>
        <label>Password<input type="password" name="password" required autocomplete="new-password"></label>
        <label>Role<select name="role"><option value="user">user</option><option value="admin">admin</option></select></label>
        <div class="foot"><button type="submit" class="btn primary">Create account</button></div>
      </form>
    </section>`;
  }

  override render() {
    const me = this.s?.account;
    if (!me) return nothing;
    return html`<h2>Your account <span class="muted small">${me.role}</span></h2>
      <form class="account-form" data-test="profile" @submit=${this.saveProfile}>
        <label>Name<input type="text" name="name" required .value=${me.name}></label>
        <label>Email<input type="email" name="email" required .value=${me.email}></label>
        <div class="foot"><button type="submit" class="btn primary">Save</button></div>
      </form>
      <form class="account-form" data-test="password" @submit=${this.changePassword}>
        <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
        <label>New password<input type="password" name="password" required autocomplete="new-password"></label>
        <label>Repeat new password<input type="password" name="repeat" required autocomplete="new-password"></label>
        <div class="foot"><button type="submit" class="btn">Change password</button></div>
      </form>
      ${themeChoice(this.s.theme, (t) => store.setTheme(t))}
      ${this.error ? html`<div class="notice error" data-test="account-error">${this.error}</div>` : nothing}
      ${this.manage ? this.manageView(me) : nothing}
      <div class="foot">
        <button class="btn danger" data-test="sign-out" @click=${this.signOut}>Sign out</button>
        <span class="spacer"></span>
        ${me.role === "admin" ? html`<button class="btn" data-test="manage" @click=${this.toggleManage}>${this.manage ? "Hide accounts" : "Manage accounts"}</button>` : nothing}
        <button class="btn" data-test="dialog-cancel" @click=${() => store.set({ dialog: null })}>Close</button>
      </div>`;
  }
}
