
/** 把还在打开的块按类型收口，返回要补发的 block-end 帧。 */
function openBlocks(open, dispatchTruncatedToolCalls) {
  const closing = [];
  for (const [index, block] of open) {
    let content;
    if (block.type === 'tool-call') {
      // 丢弃被截断的调用是派发之外的另一条路：本轮之后会因为没有 tool-call
      // 块而按 max-tokens 收尾。
      if (!dispatchTruncatedToolCalls) continue;
      // 原样透传（可能残缺的）参数文本：工具会拒绝它，错误回到模型手上，
      // 模型自己重写一次。
      content = {
        type: 'tool-call',
        id: block.id ?? '',
        name: block.name ?? '',
        arguments: block.args.length > 0 ? block.args : '{}',
      };
    } else if (block.type === 'reasoning') {
      content = { type: 'reasoning', text: block.text };
    } else {
      content = { type: 'text', text: block.text };
    }
    closing.push({ type: 'block-end', index, block: content });
  }
  open.clear();
  return closing;
}

/** 终止帧里携带的失败码（有的话）。 */
function failureCodeOf(reason) {
  if (typeof reason !== 'object' || reason === null || reason.kind !== 'error') return undefined;
  const failure = reason.failure;
  if (typeof failure !== 'object' || failure === null) return undefined;
  const code = failure.code;
  return typeof code === 'string' ? code : undefined;
}

/** 这一帧是否携带了模型产出的内容。 */
function isContentFrame(chunk) {
  return (
    chunk.type === 'block-start' ||
    chunk.type === 'block-end' ||
    (typeof chunk.type === 'string' && chunk.type.endsWith('-delta'))
  );
}
