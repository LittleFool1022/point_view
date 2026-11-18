package com.guanyao.omniscan.waydroid;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Collections;

/** OMNI 控制验收壳；复用前端，文件保存在主机，不提供 Tauri 导出。 */
public class MainActivity extends Activity {
    private WebView web;
    private ValueCallback<Uri[]> fileSelection;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.addJavascriptInterface(new Object() {
            @JavascriptInterface public void refresh() {
                runOnUiThread(() -> updateOrientation(web.getUrl()));
            }
        }, "OmniOrientation");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileSelection != null) fileSelection.onReceiveValue(null);
                fileSelection = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivityForResult(intent, 101);
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                updateOrientation(url);
                if ("tauri.localhost".equals(Uri.parse(url).getHost())) {
                    // 部分 WebView 对同一 hash 的再次访问不通知历史回调，显式监听每次路由变化。
                    view.evaluateJavascript("(() => { if (!window.__omniOrientationReady) {"
                        + "window.__omniOrientationReady = true;"
                        + "window.addEventListener('hashchange', () => OmniOrientation.refresh());"
                        + "} OmniOrientation.refresh(); })()", null);
                }
            }
            @Override public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                // 包括 hash 路由切换；旋转由 Android 完成，不通过 CSS 旋转界面。
                updateOrientation(url);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!"tauri.localhost".equals(request.getUrl().getHost())) return null;
                String path = request.getUrl().getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                if (path.contains("..")) return missing();
                String mime = path.endsWith(".js") ? "application/javascript"
                    : path.endsWith(".css") ? "text/css"
                    : path.endsWith(".html") ? "text/html"
                    : path.endsWith(".svg") ? "image/svg+xml"
                    : path.endsWith(".png") ? "image/png" : "application/octet-stream";
                try {
                    return new WebResourceResponse(mime, "UTF-8", getAssets().open(path.substring(1)));
                } catch (IOException error) { return missing(); }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !"tauri.localhost".equals(request.getUrl().getHost());
            }
        });
        web.loadUrl("http://tauri.localhost/index.html");
    }

    private void updateOrientation(String url) {
        if (url == null) return;
        Uri page = Uri.parse(url);
        if (!"tauri.localhost".equals(page.getHost())) return;
        int orientation = "/capture".equals(page.getFragment())
            ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        if (getRequestedOrientation() != orientation) setRequestedOrientation(orientation);
    }

    private static WebResourceResponse missing() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
            Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    @Override public void onBackPressed() {
        web.evaluateJavascript("window.dispatchEvent(new Event('omni:native-back'))", null);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 101 && fileSelection != null) {
            fileSelection.onReceiveValue(result == RESULT_OK && data != null && data.getData() != null
                ? new Uri[]{data.getData()} : null);
            fileSelection = null;
        }
    }

    @Override protected void onPause() { super.onPause(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() { web.destroy(); super.onDestroy(); }
}
