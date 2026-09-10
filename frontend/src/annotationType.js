/**
 * 注记类型常量（参考 html-annotation-editor-Skill 的四类产品注记）。
 * 类型决定锚点/列表/草稿的视觉标识，「修改原型」类用红色强调（待实施改动），
 * 其余类型用各自的彩色标识；状态样式（已解决/不采纳）优先级高于类型色。
 * 历史注记没有 type 时显示「未标注类型」，不自动归类。
 */
export const ANNOTATION_TYPES = ['字段说明', '交互逻辑', '业务规则', '修改原型'];

export const TYPE_META = {
  '字段说明': { label: '字段说明', color: '#2563eb' },
  '交互逻辑': { label: '交互逻辑', color: '#7c3aed' },
  '业务规则': { label: '业务规则', color: '#d97706' },
  '修改原型': { label: '修改原型', color: '#dc2626' }
};

export function typeMeta(type) {
  const meta = TYPE_META[type];
  if (meta) return meta;
  return { label: '未标注类型', color: '#6b7280' };
}