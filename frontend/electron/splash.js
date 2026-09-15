// logo 资源缺失时隐藏图片占位，保持纯文字启动画面。
// CSP 为 default-src 'self'：脚本必须是外部文件（内联脚本会被拦截）。
(function () {
  var img = document.getElementById("logo");
  if (img) img.addEventListener("error", function () { img.style.display = "none"; });
})();
