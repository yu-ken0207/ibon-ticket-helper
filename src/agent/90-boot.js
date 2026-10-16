
  // 背景程式剛被鬧鐘叫醒時第一次訊息可能失敗：沒回應就每 250ms 再問一次，最多約 10 秒
  (async () => {
    for (let i = 0; i < 40 && helloState !== 'done'; i++) {
      await hello();
      if (helloState !== 'done') await sleep(250);
    }
  })();
})();
