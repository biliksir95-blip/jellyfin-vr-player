using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Primitives;

namespace Jellyfin.Plugin.VrPlayer;

public sealed class VrPlayerMiddleware(
    RequestDelegate next,
    VrPlayerAssets assets,
    ILogger<VrPlayerMiddleware> logger,
    Func<bool> isEnabled)
{
    public const string LoaderId = "jellyfin-vr-player-loader";
    private const string AssetPath = "/web/jellyfin-vr/";
    private static readonly string[] HtmlRequestHeaders =
        ["Accept-Encoding", "Range", "If-Range", "If-None-Match", "If-Modified-Since"];

    public async Task InvokeAsync(HttpContext context)
    {
        if (!isEnabled())
        {
            await next(context).ConfigureAwait(false);
            return;
        }

        var path = context.Request.Path.Value ?? string.Empty;
        var readable = HttpMethods.IsGet(context.Request.Method) || HttpMethods.IsHead(context.Request.Method);
        var asset = path.EndsWith(AssetPath + "vr-player.js", StringComparison.OrdinalIgnoreCase) ? assets.Player
            : path.EndsWith(AssetPath + "three.min.js", StringComparison.OrdinalIgnoreCase) ? assets.Three : null;
        if (readable && asset is not null)
        {
            await ServeAssetAsync(context, asset).ConfigureAwait(false);
            return;
        }

        var webIndex = WebIndexOffset(path);
        if (!HttpMethods.IsGet(context.Request.Method) || webIndex < 0)
        {
            await next(context).ConfigureAwait(false);
            return;
        }

        var prefix = context.Request.PathBase.Value + path[..webIndex];
        var savedHeaders = HtmlRequestHeaders.ToDictionary(name => name, name => context.Request.Headers[name]);
        foreach (var name in HtmlRequestHeaders) context.Request.Headers.Remove(name);
        var original = context.Features.Get<IHttpResponseBodyFeature>()
            ?? throw new InvalidOperationException("HTTP response body is unavailable.");
        await using var capture = new BufferedResponseBody();
        context.Features.Set<IHttpResponseBodyFeature>(capture);
        try
        {
            await next(context).ConfigureAwait(false);
            await capture.CompleteAsync().ConfigureAwait(false);
        }
        finally
        {
            context.Features.Set(original);
            foreach (var (name, value) in savedHeaders)
            {
                if (StringValues.IsNullOrEmpty(value)) context.Request.Headers.Remove(name);
                else context.Request.Headers[name] = value;
            }
        }

        var bytes = capture.Buffer.ToArray();
        if (context.Response.StatusCode == StatusCodes.Status200OK
            && (context.Response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) ?? false)
            && StringValues.IsNullOrEmpty(context.Response.Headers.ContentEncoding))
        {
            try
            {
                var html = Encoding.UTF8.GetString(bytes);
                var bodyEnd = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
                if (bodyEnd >= 0 && !html.Contains(LoaderId, StringComparison.Ordinal))
                {
                    var baseUrl = HtmlEncoder.Default.Encode(prefix + AssetPath);
                    var script = $"\n<script id=\"{LoaderId}\" defer src=\"{baseUrl}vr-player.js?v={assets.Version}\" data-three-url=\"{baseUrl}three.min.js?v={assets.Version}\"></script>\n";
                    bytes = Encoding.UTF8.GetBytes(html.Insert(bodyEnd, script));
                }

                context.Response.ContentLength = bytes.Length;
                context.Response.Headers.CacheControl = "no-cache";
                foreach (var header in new[] { "ETag", "Last-Modified", "Accept-Ranges", "Content-Range", "Content-MD5" })
                    context.Response.Headers.Remove(header);
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Could not inject the VR loader; returning the original web page.");
            }
        }

        await original.Stream.WriteAsync(bytes, context.RequestAborted).ConfigureAwait(false);
    }

    private async Task ServeAssetAsync(HttpContext context, WebAsset asset)
    {
        context.Response.ContentType = "text/javascript; charset=utf-8";
        context.Response.Headers.ETag = asset.ETag;
        context.Response.Headers.XContentTypeOptions = "nosniff";
        context.Response.Headers.CacheControl = context.Request.Query["v"] == assets.Version
            ? "public, max-age=31536000, immutable" : "no-cache";
        var validators = context.Request.Headers.IfNoneMatch.ToString().Split(',');
        if (validators.Any(value => value.Trim() == "*" || value.Trim().Replace("W/", string.Empty, StringComparison.Ordinal) == asset.ETag))
        {
            context.Response.StatusCode = StatusCodes.Status304NotModified;
            return;
        }

        context.Response.ContentLength = asset.Bytes.Length;
        if (HttpMethods.IsGet(context.Request.Method))
            await context.Response.Body.WriteAsync(asset.Bytes, context.RequestAborted).ConfigureAwait(false);
    }

    private static int WebIndexOffset(string path)
    {
        foreach (var suffix in new[] { "/web/index.html", "/web/", "/web" })
        {
            if (path.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) return path.Length - suffix.Length;
        }
        return -1;
    }
}
