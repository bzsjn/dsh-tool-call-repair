window.__ModuleLoader__.load({
	id: 'dsh-tool-call-repair',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const { createElement: h, useMemo, useEffect, useState, useCallback } = require('react');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		const { SettingsFormModel, settingsNumberField } = primitives;

		/** configForms namespace: the entry id this bundle inserts in cordis.patch.yml. */
		const NS = 'tool-call-repair';

		/** The browser plugin context, captured by apply() so the section can read its own form scope. */
		let ctxRef = null;

		const TEXT = {
			zh: {
				title: '工具调用修复',
				hint: '上游把工具参数截断、或请求因网络中断失败时，兜底并重试，避免整轮任务被打断。',
				toolFix: '工具修复',
				toolFixHint: '开启时补发缺失的输出块，把被截断的工具调用交回模型重写，而不是让整轮失败。',
				retries: '重试次数',
				retriesHint: '失败重试上限。0 表示不重试。12 次的退避窗口约 20 分钟。',
				tokenCap: 'token 上限',
				tokenCapHint: '本轮输出字符预算，达到即截断收尾。0 表示不干预。中文约 1 字≈1 token。',
				save: '保存',
				saved: '已保存',
				readonly: '此部署不可写',
				unavailable: '插件未加载，暂时无法配置。',
				pointer: '配置项已集中到「设置 → 工具调用修复」，此处不再重复提供。',
			},
			en: {
				title: 'Tool call repair',
				hint: 'Fallback and retry for truncated tool arguments and transport failures.',
				toolFix: 'Tool fix',
				toolFixHint: 'Closes a truncated stream and hands the broken call back to the model instead of failing the turn.',
				retries: 'Retries',
				retriesHint: 'Retry budget. 0 disables retrying. 12 runs about a 20 minute backoff window.',
				tokenCap: 'Token cap',
				tokenCapHint: 'Output character budget for one turn; reaching it truncates cleanly. 0 leaves it alone.',
				save: 'Save',
				saved: 'Saved',
				readonly: 'Read-only on this deployment',
				unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
				pointer: 'These switches live in Settings → Tool call repair; they are not duplicated here.',
			},
		};

		const dict = () => {
			const lang = String((typeof navigator !== 'undefined' && navigator.language) || '');
			return lang.toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en;
		};

		/** The shared form model is text based; a checkbox maps through true/false. */
		function boolSpec(field) {
			return {
				field,
				format: (value) => (value === true ? 'true' : 'false'),
				parse: (text) => ({ kind: 'set', value: String(text).trim().toLowerCase() === 'true' }),
			};
		}

		const SPECS = [boolSpec('工具修复'), settingsNumberField('重试次数'), settingsNumberField('token上限')];

		const inputStyle = { width: '140px', padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit' };

		function row(label, hint, control) {
			return h('div', { style: { marginBottom: '16px' } },
				h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, label),
				control,
				h('div', { style: { fontSize: '12px', opacity: 0.65, marginTop: '6px', lineHeight: 1.5 } }, hint));
		}

		/**
		 * The settings sidebar page: title, one paragraph of context, and the three
		 * volatile switches this bundle declares in its Config schema.
		 *
		 * Hooks stay unconditional so a view swap cannot change their order.
		 */
		function RepairSection(props) {
			const copy = dict();
			const scope = ctxRef === null ? undefined : ctxRef.configForms.get(NS);
			const model = useMemo(
				() => (scope === undefined ? null : new SettingsFormModel(scope, SPECS)),
				[scope],
			);
			const [, force] = useState(0);
			const rerender = useCallback(() => force((n) => n + 1), []);
			const [flash, setFlash] = useState('');

			useEffect(() => () => { if (model !== null) model.dispose(); }, [model]);

			if (props.view === 'summary') return h('span', null, copy.title);
			if (model === null) return h('span', { style: { opacity: 0.7 } }, copy.unavailable);

			const shell = model.shell();
			const read = (name) => model.field(name).text;
			const actions = model.actions();
			const edit = (name, text) => { actions.edit(name, text); rerender(); };
			const toolFixOn = read('工具修复') === 'true';

			const onSave = async () => {
				setFlash('');
				await model.save();
				rerender();
				setFlash(model.shell().failed ? '' : copy.saved);
			};

			return h('div', { style: { maxWidth: '760px', padding: '4px 0 10px', display: 'flex', flexDirection: 'column', gap: '4px' } },
				h('div', { style: { fontSize: '16px', fontWeight: 700, marginBottom: '6px' } }, copy.title),
				h('div', { style: { opacity: 0.75, marginBottom: '12px', lineHeight: 1.5 } }, copy.hint),

				row(copy.toolFix, copy.toolFixHint, h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
					h('input', {
						type: 'checkbox',
						checked: toolFixOn,
						disabled: !shell.writable,
						onChange: (event) => edit('工具修复', event.target.checked ? 'true' : 'false'),
					}),
					h('span', null, toolFixOn ? 'on' : 'off'))),

				row(copy.retries, copy.retriesHint, h('input', {
					type: 'number',
					min: 0,
					style: inputStyle,
					value: read('重试次数'),
					disabled: !shell.writable,
					onChange: (event) => edit('重试次数', event.target.value),
				})),

				row(copy.tokenCap, copy.tokenCapHint, h('input', {
					type: 'number',
					min: 0,
					style: inputStyle,
					value: read('token上限'),
					disabled: !shell.writable,
					onChange: (event) => edit('token上限', event.target.value),
				})),

				h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
					h('button', {
						type: 'button',
						disabled: !shell.writable || shell.saving || !shell.dirty,
						onClick: onSave,
						style: { padding: '6px 18px', borderRadius: '6px', cursor: shell.dirty ? 'pointer' : 'default' },
					}, copy.save),
					flash ? h('span', { style: { opacity: 0.7, fontSize: '12px' } }, flash) : null,
					!shell.writable ? h('span', { style: { opacity: 0.7, fontSize: '12px' } }, copy.readonly) : null,
					shell.failed ? h('span', { style: { color: '#d9534f', fontSize: '12px' } }, 'save failed') : null));
		}

		/**
		 * A one-line pointer for the plugin manager's package page.
		 *
		 * The bundle used to register an editable copy of the three switches into
		 * `plugins.bundle.config`; that block is now a pointer, so exactly one editable
		 * form exists: the Settings section below. `plugins.row.config` stays
		 * unregistered on purpose — an entry there would add a "configure" control to
		 * the row and open a page with nothing to edit.
		 */
		function ConfigPointer() {
			return h('div', { style: { opacity: 0.7, fontSize: '12px', lineHeight: 1.5 } }, dict().pointer);
		}

		/**
		 * Register the one Settings page, and replace the manager's package-page config
		 * block with a pointer.
		 *
		 * The page is mounted only while the Host serves this plugin's config namespace,
		 * so a deployment without the bundle shows no trace of it.
		 */
		function apply(ctx) {
			ctxRef = ctx;
			ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'tool-call-repair',
				order: 16,
				label: () => dict().title,
			}, RepairSection))));
			ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
				name: 'plugins.bundle.config',
				key: 'dsh-tool-call-repair',
			}, ConfigPointer)));
		}

		exports.name = 'tool-call-repair-client';
		exports.inject = ['slots', 'configForms'];
		exports.apply = apply;
		return module.exports;
	},
});