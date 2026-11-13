window.__ModuleLoader__.load({
	id: 'dsh-tool-call-repair',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const { createElement: h, useMemo, useEffect, useState, useCallback } = require('react');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		const { SettingsFormModel, settingsNumberField } = primitives;

		const NS = 'tool-call-repair';
		const KEY = 'dsh-tool-call-repair';

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

		const row = (label, hint, control) => h('div', { key: label, style: { marginBottom: '16px' } },
			h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, label),
			control,
			h('div', { style: { fontSize: '12px', opacity: 0.65, marginTop: '6px', lineHeight: 1.5 } }, hint));

		const inputStyle = { width: '140px', padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit' };

		function RepairPanel({ scope, copy }) {
			const model = useMemo(() => new SettingsFormModel(scope, [
				boolSpec('工具修复'),
				settingsNumberField('重试次数'),
				settingsNumberField('token上限'),
			]), [scope]);

			const [, force] = useState(0);
			const rerender = useCallback(() => force((n) => n + 1), []);
			const [flash, setFlash] = useState('');

			useEffect(() => () => model.dispose(), [model]);

			const shell = model.shell();
			const read = (name) => model.field(name).text;
			const actions = model.actions();
			const edit = (name, text) => { actions.edit(name, text); rerender(); };

			const onSave = async () => {
				setFlash('');
				const before = model.shell().saving;
				await model.save();
				rerender();
				setFlash(model.shell().failed ? '' : copy.saved);
			};

			const toolFixOn = read('工具修复') === 'true';

			return h('div', { style: { padding: '4px 0 10px' } },
				h('div', { style: { fontSize: '16px', fontWeight: 700, marginBottom: '6px' } }, copy.title),
				h('div', { style: { opacity: 0.75, marginBottom: '16px', lineHeight: 1.5 } }, copy.hint),

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

		function apply(ctx) {
			ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
				name: 'plugins.bundle.config',
				key: KEY,
				locale: 'tool-call-repair',
			}, ({ view }) => {
				const copy = dict();
				if (view === 'summary') return copy.title;
				return h(RepairPanel, { scope: ctx.configForms.get(NS), copy });
			}))));
		}

		exports.name = 'tool-call-repair-client';
		exports.inject = ['slots', 'configForms'];
		exports.apply = apply;
		return module.exports;
	},
});