/** Electron 会静默接受 beforeunload 的阻止；需要显式提供关闭决定。 */
function installCloseGuard(window, dialog, onDiscard) {
  let prompting = false;
  window.webContents.on('will-prevent-unload', event => {
    if (prompting) return;
    prompting = true;
    try {
      const choice = dialog.showMessageBoxSync(window, {
        type: 'question',
        title: '关闭测量成果工作台',
        message: '工程尚未保存，或有任务正在运行。',
        detail: '返回工作台可先保存工程。放弃并关闭会丢弃未保存的修改、取消当前任务；原始点云和已保存工程保留。',
        buttons: ['返回工作台', '放弃修改并关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice === 1) {
        onDiscard();
        // 此事件的 preventDefault 表示忽略 renderer 的阻止，允许正常关闭。
        event.preventDefault();
      }
    } finally {
      prompting = false;
    }
  });
}
module.exports = { installCloseGuard };
