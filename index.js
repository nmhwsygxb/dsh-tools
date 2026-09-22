// dsh-tools bundle 入口。
// 本包是纯 host 工具插件集合，全部插件由 cordis.patch.yml 的 insert 行按相对路径加载，
// 这里仅作为 package.json 的 main 占位（pnpm 安装需要可解析入口，不加载任何逻辑）。
'use strict';

module.exports = {
  name: 'dsh-tools',
  description: 'dsh-tools bundle: 9 host tool plugins (see cordis.patch.yml)',
};
