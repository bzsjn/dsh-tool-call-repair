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
				autoContinue: '自动续写',
				autoContinueHint: '达到输出上限时不结束本轮，自动再发一次请求接着写。每次续写都是一次完整请求，会计费。',
				continueRounds: '续写轮数',
				continueRoundsHint: '最多自动续写几轮，到顶即按截断收尾。',
				save: '保存',
				saved: '已保存',
				readonly: '此部署不可写',
				unavailable: '插件未加载，暂时无法配置。',
				pointer: '配置项已集中到「设置 → 工具调用修复」，此处不再重复提供。',
				advanced: '高级：退避与预算',
				advancedHint: '这些值改动后即时生效，无需重启。留空则用默认值。',
				perTurn: '整轮重试预算',
				perTurnHint: '同一轮对话内所有 step 的重试次数总和上限，防跨 step 累计成死循环。',
				codes: '参与重试的失败码',
				codesHint: '逗号分隔，* 表示全部。ABORTED、CONTEXT_WINDOW_EXCEEDED、INVALID_REPLAY_STATE、NO_ADAPTER 永不重试。',
				initialDelay: '首次退避 (ms)',
				initialDelayHint: '第 1 次重试前等待的毫秒数，之后按 2 的幂递增。',
				maxDelay: '退避上限 (ms)',
				maxDelayHint: '单次等待的封顶值，默认 240000 即 4 分钟。',
				jitter: '抖动比例',
				jitterHint: '0 到 1 之间的随机抖动幅度，0 表示不抖动。',
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
				autoContinue: 'Auto-continue',
				autoContinueHint: 'Instead of ending the turn at the output ceiling, send one more request and keep writing. Every continuation is a full billed request.',
				continueRounds: 'Continuation rounds',
				continueRoundsHint: 'How many automatic continuations to allow; past this the turn ends as truncated.',
				save: 'Save',
				saved: 'Saved',
				readonly: 'Read-only on this deployment',
				unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
				pointer: 'These switches live in Settings → Tool call repair; they are not duplicated here.',
				advanced: 'Advanced: backoff and budget',
				advancedHint: 'Changes apply immediately, no restart. Leave a field empty to use its default.',
				perTurn: 'Per-turn retry budget',
				perTurnHint: 'Upper bound on retries across every step of one turn; stops step-level budgets from compounding.',
				codes: 'Retryable failure codes',
				codesHint: 'Comma separated, * means all. ABORTED, CONTEXT_WINDOW_EXCEEDED, INVALID_REPLAY_STATE and NO_ADAPTER are never retried.',
				initialDelay: 'Initial delay (ms)',
				initialDelayHint: 'Wait before the first retry; later attempts double it.',
				maxDelay: 'Max delay (ms)',
				maxDelayHint: 'Cap for a single wait; the default 240000 is four minutes.',
				jitter: 'Jitter ratio',
				jitterHint: 'Random spread between 0 and 1; 0 means no jitter.',
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

		/** `codes` is an array in the schema, so it stages as comma separated text. */
		const codesSpec = {
			field: 'codes',
			format: (value) => (Array.isArray(value) ? value.join(', ') : '*'),
			parse: (text) => {
				const parts = String(text).split(',').map((part) => part.trim()).filter((part) => part !== '');
				return parts.length === 0 ? { kind: 'clear' } : { kind: 'set', value: parts };
			},
		};

		const SPECS = [
			boolSpec('工具修复'),
			settingsNumberField('重试次数'),
			settingsNumberField('token上限'),
			boolSpec('自动续写'),
			settingsNumberField('续写轮数'),
			settingsNumberField('maxRetriesPerTurn'),
			settingsNumberField('initialDelayMs'),
			settingsNumberField('maxDelayMs'),
			settingsNumberField('jitterRatio'),
			codesSpec,
		];

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

				row(copy.autoContinue, copy.autoContinueHint, h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
					h('input', {
						type: 'checkbox',
						checked: read('自动续写') === 'true',
						disabled: !shell.writable,
						onChange: (event) => edit('自动续写', event.target.checked ? 'true' : 'false'),
					}),
					h('span', null, read('自动续写') === 'true' ? 'on' : 'off'))),

				row(copy.continueRounds, copy.continueRoundsHint, h('input', {
					type: 'number',
					min: 0,
					style: inputStyle,
					value: read('续写轮数'),
					disabled: !shell.writable,
					onChange: (event) => edit('续写轮数', event.target.value),
				})),

				h('div', { style: { margin: '8px 0 14px', borderTop: '1px solid rgba(127,127,127,0.25)' } }),
				h('div', { style: { fontSize: '14px', fontWeight: 700, marginBottom: '4px' } }, copy.advanced),
				h('div', { style: { opacity: 0.7, fontSize: '12px', marginBottom: '14px', lineHeight: 1.5 } }, copy.advancedHint),

				row(copy.perTurn, copy.perTurnHint, h('input', {
					type: 'number',
					min: 0,
					style: inputStyle,
					value: read('maxRetriesPerTurn'),
					disabled: !shell.writable,
					onChange: (event) => edit('maxRetriesPerTurn', event.target.value),
				})),

				row(copy.codes, copy.codesHint, h('input', {
					type: 'text',
					style: { ...inputStyle, width: '100%', maxWidth: '420px' },
					value: read('codes'),
					disabled: !shell.writable,
					onChange: (event) => edit('codes', event.target.value),
				})),

				row(copy.initialDelay, copy.initialDelayHint, h('input', {
					type: 'number',
					min: 0,
					style: inputStyle,
					value: read('initialDelayMs'),
					disabled: !shell.writable,
					onChange: (event) => edit('initialDelayMs', event.target.value),
				})),

				row(copy.maxDelay, copy.maxDelayHint, h('input', {
					type: 'number',
					min: 0,
					style: inputStyle,
					value: read('maxDelayMs'),
					disabled: !shell.writable,
					onChange: (event) => edit('maxDelayMs', event.target.value),
				})),

				row(copy.jitter, copy.jitterHint, h('input', {
					type: 'number',
					min: 0,
					max: 1,
					step: 0.05,
					style: inputStyle,
					value: read('jitterRatio'),
					disabled: !shell.writable,
					onChange: (event) => edit('jitterRatio', event.target.value),
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
			// Sidebar icon: two sliders, drawn with currentColor so it follows the theme.
			ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
				name: 'settings.section.icon',
				key: 'tool-call-repair',
			}, function RepairIcon(props) {
				const size = typeof props.size === 'number' ? props.size : 16;
				return h('svg', {
					width: size,
					height: size,
					viewBox: '0 0 16 16',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.4,
					strokeLinecap: 'round',
					'aria-hidden': 'true',
				},
				h('path', { d: 'M2 5.5h6M11 5.5h3M2 10.5h3M8 10.5h6' }),
				h('circle', { cx: 9.5, cy: 5.5, r: 1.7 }),
				h('circle', { cx: 5.5, cy: 10.5, r: 1.7 }));
			})));
		}

		exports.name = 'tool-call-repair-client';
		exports.inject = ['slots', 'configForms'];
		exports.apply = apply;
		return module.exports;
	},
});