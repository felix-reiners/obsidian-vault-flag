'use strict';

const { Plugin, PluginSettingTab, Setting, debounce } = require('obsidian');

const DEFAULT_SETTINGS = {
	showInWindowTitle: true,
	// Keyed by vault name, so one settings file can be shared across vaults
	// (Settings Profiles, a synced .obsidian folder) and each vault still
	// finds its own row.
	vaults: {},
};

const TITLE_SEPARATOR = ' · ';

// A stable, readable color derived from the vault name, used until the user picks one.
function automaticColor(name) {
	let hash = 0;
	for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
	return hslToHex(hash % 360, 0.55, 0.4);
}

function hslToHex(h, s, l) {
	const a = s * Math.min(l, 1 - l);
	const channel = (n) => {
		const k = (n + h / 30) % 12;
		const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		return Math.round(c * 255).toString(16).padStart(2, '0');
	};
	return `#${channel(0)}${channel(8)}${channel(4)}`;
}

function relativeLuminance(hex) {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return 0;
	const [r, g, b] = [0, 2, 4].map((i) => {
		const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Picks dark or light text, whichever contrasts more with the background.
function textColorFor(hex) {
	const l = relativeLuminance(hex);
	const onWhite = 1.05 / (l + 0.05);
	const onDark = (l + 0.05) / (0.0056 + 0.05);
	return onWhite >= onDark ? '#ffffff' : '#111111';
}

function cleanEntry(entry) {
	const out = {};
	for (const key of ['label', 'emoji', 'color']) {
		const value = (entry && entry[key] ? String(entry[key]) : '').trim();
		if (value) out[key] = value;
	}
	return Object.keys(out).length ? out : null;
}

class VaultFlagPlugin extends Plugin {
	async onload() {
		this.vaultName = this.app.vault.getName();
		this.docs = new Set();
		this.titleObservers = new Map();
		this.titlePrefixes = new WeakMap();
		this.removedVaults = new Set();
		this.requestSave = debounce(() => this.persist(), 400, true);

		await this.loadSettings();
		this.settingTab = new VaultFlagSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.app.workspace.onLayoutReady(() => this.attach(document));
		this.registerEvent(this.app.workspace.on('window-open', (_win, win) => this.attach(win.document)));
		this.registerEvent(this.app.workspace.on('window-close', (_win, win) => this.detach(win.document)));
	}

	onunload() {
		for (const doc of [...this.docs]) this.detach(doc);
	}

	async onExternalSettingsChange() {
		await this.loadSettings();
		this.refresh();
	}

	async loadSettings() {
		const data = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data, { vaults: Object.assign({}, data.vaults) });
	}

	// Writes only what this vault changed, on top of whatever is on disk now,
	// so a stale copy in one vault never wipes rows another vault added.
	async persist() {
		const disk = (await this.loadData()) || {};
		const vaults = Object.assign({}, disk.vaults);
		const own = cleanEntry(this.settings.vaults[this.vaultName]);
		if (own) vaults[this.vaultName] = own;
		else delete vaults[this.vaultName];
		for (const name of this.removedVaults) delete vaults[name];
		this.removedVaults.clear();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, disk, {
			showInWindowTitle: this.settings.showInWindowTitle,
			vaults,
		});
		await this.saveData(this.settings);
	}

	ownEntry() {
		return this.settings.vaults[this.vaultName] || {};
	}

	flag() {
		const entry = this.ownEntry();
		return {
			label: entry.label || this.vaultName,
			emoji: entry.emoji || '',
			color: entry.color || automaticColor(this.vaultName),
		};
	}

	editOwn(changes) {
		this.settings.vaults[this.vaultName] = Object.assign({}, this.ownEntry(), changes);
		this.refresh();
		this.requestSave();
	}

	setGlobal(changes) {
		Object.assign(this.settings, changes);
		this.refresh();
		this.requestSave();
	}

	removeVault(name) {
		delete this.settings.vaults[name];
		this.removedVaults.add(name);
		this.requestSave();
	}

	refresh() {
		for (const doc of this.docs) {
			this.renderBar(doc);
			this.applyTitle(doc);
		}
		if (this.settingTab.preview) this.paint(this.settingTab.preview);
	}

	attach(doc) {
		if (this.docs.has(doc)) return;
		this.docs.add(doc);
		this.renderBar(doc);
		const titleEl = doc.querySelector('title');
		if (titleEl) {
			const observer = new MutationObserver(() => this.applyTitle(doc));
			observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
			this.titleObservers.set(doc, observer);
		}
		this.applyTitle(doc);
	}

	detach(doc) {
		const observer = this.titleObservers.get(doc);
		if (observer) observer.disconnect();
		this.titleObservers.delete(doc);
		this.stripTitle(doc);
		doc.querySelectorAll('.vault-flag-bar').forEach((el) => el.remove());
		doc.body.removeClass('has-vault-flag');
		this.docs.delete(doc);
	}

	renderBar(doc) {
		const container = doc.querySelector('.app-container');
		if (!container) return;
		let bar = container.querySelector(':scope > .vault-flag-bar');
		if (!bar) {
			bar = doc.createElement('div');
			bar.addClass('vault-flag-bar');
			container.prepend(bar);
		}
		this.paint(bar);
		doc.body.addClass('has-vault-flag');
	}

	paint(el) {
		const flag = this.flag();
		el.empty();
		el.setCssProps({
			'--vault-flag-bg': flag.color,
			'--vault-flag-fg': textColorFor(flag.color),
		});
		if (flag.emoji) el.createSpan({ cls: 'vault-flag-emoji', text: flag.emoji });
		el.createSpan({ cls: 'vault-flag-label', text: flag.label });
	}

	titlePrefix() {
		if (!this.settings.showInWindowTitle) return '';
		const flag = this.flag();
		return (flag.emoji ? `${flag.emoji} ` : '') + flag.label + TITLE_SEPARATOR;
	}

	applyTitle(doc) {
		const previous = this.titlePrefixes.get(doc) || '';
		let base = doc.title;
		if (previous && base.startsWith(previous)) base = base.slice(previous.length);
		const prefix = this.titlePrefix();
		this.titlePrefixes.set(doc, prefix);
		const next = prefix + base;
		if (doc.title !== next) doc.title = next;
	}

	stripTitle(doc) {
		const previous = this.titlePrefixes.get(doc) || '';
		if (previous && doc.title.startsWith(previous)) doc.title = doc.title.slice(previous.length);
		this.titlePrefixes.delete(doc);
	}
}

class VaultFlagSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.preview = null;
	}

	display() {
		const { containerEl } = this;
		const plugin = this.plugin;
		const own = plugin.ownEntry();
		containerEl.empty();

		new Setting(containerEl).setName(`This vault: ${plugin.vaultName}`).setHeading();
		this.preview = containerEl.createDiv({ cls: 'vault-flag-bar vault-flag-preview' });
		plugin.paint(this.preview);

		new Setting(containerEl)
			.setName('Name')
			.setDesc('Shown in the bar. Leave empty to use the vault name.')
			.addText((text) =>
				text
					.setPlaceholder(plugin.vaultName)
					.setValue(own.label || '')
					.onChange((value) => plugin.editOwn({ label: value.trim() }))
			);

		new Setting(containerEl)
			.setName('Emoji')
			.setDesc('Optional. On macOS, Ctrl+Cmd+Space opens the emoji picker.')
			.addText((text) =>
				text
					.setPlaceholder('🚀')
					.setValue(own.emoji || '')
					.onChange((value) => plugin.editOwn({ emoji: value.trim() }))
			);

		new Setting(containerEl)
			.setName('Color')
			.setDesc('Bar background. The text switches between dark and light to stay readable.')
			.addColorPicker((picker) =>
				picker.setValue(plugin.flag().color).onChange((value) => plugin.editOwn({ color: value }))
			)
			.addExtraButton((button) =>
				button
					.setIcon('rotate-ccw')
					.setTooltip('Back to the automatic color')
					.onClick(() => {
						plugin.editOwn({ color: '' });
						this.display();
					})
			);

		new Setting(containerEl).setName('All vaults').setHeading();

		new Setting(containerEl)
			.setName('Add to window title')
			.setDesc('Puts the emoji and name in front of the window title, so the Dock menu, the Window menu and window switchers show it.')
			.addToggle((toggle) =>
				toggle
					.setValue(plugin.settings.showInWindowTitle)
					.onChange((value) => plugin.setGlobal({ showInWindowTitle: value }))
			);

		const others = Object.keys(plugin.settings.vaults)
			.filter((name) => name !== plugin.vaultName)
			.sort((a, b) => a.localeCompare(b));
		if (!others.length) return;

		new Setting(containerEl)
			.setName('Other vaults in this table')
			.setDesc('These settings are stored by vault name. When several vaults share one settings file, each picks its own row and ignores the rest.')
			.setHeading();

		for (const name of others) {
			const entry = plugin.settings.vaults[name];
			const row = new Setting(containerEl)
				.setName(`${entry.emoji ? `${entry.emoji} ` : ''}${entry.label || name}`)
				.setDesc(name)
				.addExtraButton((button) =>
					button
						.setIcon('trash')
						.setTooltip('Remove from the table')
						.onClick(() => {
							plugin.removeVault(name);
							this.display();
						})
				);
			const swatch = row.nameEl.createSpan({ cls: 'vault-flag-swatch' });
			swatch.setCssProps({ '--vault-flag-bg': entry.color || automaticColor(name) });
			row.nameEl.prepend(swatch);
		}
	}

	hide() {
		this.preview = null;
	}
}

module.exports = VaultFlagPlugin;
