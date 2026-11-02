using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Jellyfin.Plugin.VrPlayer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var fixtureRoot = Path.Combine(AppContext.BaseDirectory, "fixtures");
var originalHtml = await File.ReadAllTextAsync(Path.Combine(fixtureRoot, "index.html"));
var checks = 0;
void Check(bool passed, string message)
{
    if (!passed) throw new InvalidOperationException(message);
    checks++;
}

using var host = Host.CreateDefaultBuilder()
    .ConfigureLogging(logging => logging.ClearProviders())
    .ConfigureWebHostDefaults(web => web.UseKestrel().UseUrls("http://127.0.0.1:0")
        .ConfigureServices(services =>
        {
            services.AddSingleton<VrPlayerAssets>();
            services.AddSingleton<IStartupFilter, VrPlayerStartupFilter>();
            services.AddResponseCompression();
        })
        .Configure(app =>
        {
            app.Map("/jellyfin", branch => ConfigureDownstream(branch));
            ConfigureDownstream(app);
        }))
    .Build();

void ConfigureDownstream(IApplicationBuilder app)
{
    app.UseResponseCompression();
    app.Use(async (context, next) =>
    {
        var path = context.Request.Path.Value ?? "";
        if (path.StartsWith("/body-writer/", StringComparison.Ordinal))
        {
            context.Response.ContentType = "text/html; charset=utf-8";
            context.Response.ContentLength = Encoding.UTF8.GetByteCount(originalHtml);
            await context.Response.StartAsync();
            await context.Response.BodyWriter.WriteAsync(Encoding.UTF8.GetBytes(originalHtml));
            return;
        }
        if (path.StartsWith("/existing/", StringComparison.Ordinal))
        {
            context.Response.ContentType = "text/html";
            await context.Response.WriteAsync($"<html><body><script id=\"{VrPlayerMiddleware.LoaderId}\"></script></body></html>");
            return;
        }
        if (path.StartsWith("/no-body/", StringComparison.Ordinal))
        {
            context.Response.ContentType = "text/html";
            await context.Response.WriteAsync("<html><head></head></html>");
            return;
        }
        if (path.StartsWith("/not-html/", StringComparison.Ordinal))
        {
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync("{\"ok\":true}");
            return;
        }
        if (path.StartsWith("/forced-gzip/", StringComparison.Ordinal))
        {
            context.Response.ContentType = "text/html";
            context.Response.Headers.ContentEncoding = "gzip";
            await using var zipped = new GZipStream(context.Response.Body, CompressionLevel.Fastest, leaveOpen: true);
            await zipped.WriteAsync(Encoding.UTF8.GetBytes(originalHtml));
            return;
        }
        if (path == "/api/probe")
        {
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(context.Request.Headers.IfNoneMatch.ToString() + "|" + context.Request.Headers.Range);
            return;
        }
        if (path.StartsWith("/Videos/", StringComparison.Ordinal))
        {
            context.Response.ContentType = "video/mp4";
            await context.Response.WriteAsync("video-stream-unchanged");
            return;
        }
        await next();
    });
    var provider = new PhysicalFileProvider(fixtureRoot);
    app.UseDefaultFiles(new DefaultFilesOptions { RequestPath = "/web", FileProvider = provider });
    app.UseStaticFiles(new StaticFileOptions { RequestPath = "/web", FileProvider = provider });
    app.Run(context => { context.Response.StatusCode = 404; return Task.CompletedTask; });
}

await host.StartAsync();
try
{
    var address = host.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
    using var handler = new HttpClientHandler { AllowAutoRedirect = false, AutomaticDecompression = DecompressionMethods.None };
    using var client = new HttpClient(handler) { BaseAddress = new Uri(address) };
    foreach (var path in new[] { "/web/index.html", "/web/", "/jellyfin/web/index.html", "/jellyfin/web/" })
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("gzip"));
        request.Headers.IfNoneMatch.Add(new EntityTagHeaderValue("\"old-page\""));
        request.Headers.TryAddWithoutValidation("Range", "bytes=0-10");
        using var response = await client.SendAsync(request);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        var html = Encoding.UTF8.GetString(bytes);
        var prefix = path.StartsWith("/jellyfin/", StringComparison.Ordinal) ? "/jellyfin" : "";
        Check(response.StatusCode == HttpStatusCode.OK, $"Full HTML was not served: {path}");
        Check(html.Contains(VrPlayerMiddleware.LoaderId) && html.Contains("Jellyfin 测试"), $"Missing loader or broken UTF-8: {path}");
        Check(html.Contains($"src=\"{prefix}/web/jellyfin-vr/vr-player.js?v="), $"Wrong base path: {path}");
        Check(html.Contains($"data-three-url=\"{prefix}/web/jellyfin-vr/three.min.js?v="), $"Wrong Three.js URL: {path}");
        Check(response.Content.Headers.ContentLength == bytes.Length, $"Invalid rewritten content length: {path}");
        Check(response.Headers.ETag is null && response.Headers.CacheControl?.NoCache == true, $"Stale HTML cache validators: {path}");
        Check(response.Content.Headers.ContentEncoding.Count == 0, $"Unexpected compressed HTML: {path}");
    }

    var assets = host.Services.GetRequiredService<VrPlayerAssets>();
    foreach (var (name, asset) in new[] { ("vr-player.js", assets.Player), ("three.min.js", assets.Three) })
    {
        using var response = await client.GetAsync($"/jellyfin/web/jellyfin-vr/{name}?v={assets.Version}");
        Check((await response.Content.ReadAsByteArrayAsync()).SequenceEqual(asset.Bytes), $"Embedded asset mismatch: {name}");
        Check(response.Content.Headers.ContentType?.MediaType == "text/javascript", $"Invalid asset MIME type: {name}");
        Check(response.Headers.CacheControl?.Extensions.Any(value => value.Name == "immutable") == true, $"Missing versioned asset cache: {name}");
        using var conditional = new HttpRequestMessage(HttpMethod.Get, $"/web/jellyfin-vr/{name}");
        conditional.Headers.TryAddWithoutValidation("If-None-Match", "W/" + asset.ETag);
        using var cached = await client.SendAsync(conditional);
        Check(cached.StatusCode == HttpStatusCode.NotModified, $"Asset conditional request failed: {name}");
        using var head = new HttpRequestMessage(HttpMethod.Head, $"/web/jellyfin-vr/{name}");
        using var headResponse = await client.SendAsync(head);
        Check(headResponse.Content.Headers.ContentLength == asset.Bytes.Length && (await headResponse.Content.ReadAsByteArrayAsync()).Length == 0, $"Asset HEAD failed: {name}");
    }

    foreach (var path in new[] { "/web", "/jellyfin/web" })
    {
        using var response = await client.GetAsync(path);
        Check((int)response.StatusCode is >= 300 and < 400, $"Host redirect was changed: {path}");
    }
    using (var request = new HttpRequestMessage(HttpMethod.Head, "/web/index.html"))
    using (var response = await client.SendAsync(request))
        Check(response.Content.Headers.ContentLength == Encoding.UTF8.GetByteCount(originalHtml), "HTML HEAD headers were changed");

    var streamed = await client.GetStringAsync("/body-writer/web/index.html");
    Check(streamed.Contains(VrPlayerMiddleware.LoaderId), "Explicit response start / BodyWriter injection failed");
    var existing = await client.GetStringAsync("/existing/web/index.html");
    Check(existing.Split(VrPlayerMiddleware.LoaderId).Length == 2, "Loader was injected twice");
    Check(await client.GetStringAsync("/no-body/web/index.html") == "<html><head></head></html>", "Malformed HTML was changed");
    Check(await client.GetStringAsync("/not-html/web/index.html") == "{\"ok\":true}", "Non-HTML response was changed");
    using (var response = await client.GetAsync("/forced-gzip/web/index.html"))
    {
        await using var body = await response.Content.ReadAsStreamAsync();
        await using var gzip = new GZipStream(body, CompressionMode.Decompress);
        using var reader = new StreamReader(gzip);
        Check(await reader.ReadToEndAsync() == originalHtml, "An already-compressed response was corrupted");
    }
    using (var request = new HttpRequestMessage(HttpMethod.Get, "/api/probe"))
    {
        request.Headers.TryAddWithoutValidation("If-None-Match", "\"keep\"");
        request.Headers.TryAddWithoutValidation("Range", "bytes=0-10");
        using var response = await client.SendAsync(request);
        Check(await response.Content.ReadAsStringAsync() == "\"keep\"|bytes=0-10", "API request headers were changed");
    }
    Check(await client.GetStringAsync("/Videos/id/stream.mp4") == "video-stream-unchanged", "Video streaming was changed");
    using (var response = await client.GetAsync("/missing/web/index.html"))
        Check(response.StatusCode == HttpStatusCode.NotFound, "Missing web pages were changed");

    var disabled = new DefaultHttpContext();
    disabled.Request.Path = "/web/index.html";
    disabled.Request.Method = "GET";
    disabled.Response.Body = new MemoryStream();
    var bypass = new VrPlayerMiddleware(async context =>
    {
        context.Response.ContentType = "text/html";
        await context.Response.WriteAsync(originalHtml);
    }, assets, NullLogger<VrPlayerMiddleware>.Instance, () => false);
    await bypass.InvokeAsync(disabled);
    Check(Encoding.UTF8.GetString(((MemoryStream)disabled.Response.Body).ToArray()) == originalHtml, "Disabling the plugin did not bypass injection");

    var failed = new DefaultHttpContext();
    failed.Request.Path = "/web/index.html";
    failed.Request.Method = "GET";
    failed.Request.Headers.AcceptEncoding = "gzip";
    var failureBody = new MemoryStream();
    failed.Response.Body = failureBody;
    var broken = new VrPlayerMiddleware(async context =>
    {
        await context.Response.WriteAsync("partial");
        throw new InvalidOperationException("downstream error");
    }, assets, NullLogger<VrPlayerMiddleware>.Instance, () => true);
    try { await broken.InvokeAsync(failed); throw new Exception("Expected downstream failure"); }
    catch (InvalidOperationException exception) when (exception.Message == "downstream error") { }
    Check(failureBody.Length == 0 && ReferenceEquals(failed.Response.Body, failureBody), "Downstream failure leaked a partial response");
    Check(failed.Request.Headers.AcceptEncoding == "gzip", "Request headers were not restored after failure");
    Console.WriteLine($"PASS: {checks} HTTP, resource and failure checks.");
}
finally
{
    await host.StopAsync();
}
