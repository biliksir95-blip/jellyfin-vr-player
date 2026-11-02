using System.IO.Pipelines;
using Microsoft.AspNetCore.Http.Features;

namespace Jellyfin.Plugin.VrPlayer;

// Defer response start until HTML has been transformed, including SendFileAsync
// and BodyWriter paths used by ASP.NET's static-file middleware.
internal sealed class BufferedResponseBody : IHttpResponseBodyFeature, IAsyncDisposable
{
    private PipeWriter? _writer;

    public MemoryStream Buffer { get; } = new();

    public Stream Stream => Buffer;

    public PipeWriter Writer => _writer ??= PipeWriter.Create(Buffer, new StreamPipeWriterOptions(leaveOpen: true));

    public void DisableBuffering() { }

    public Task StartAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

    public async Task CompleteAsync()
    {
        if (_writer is not null)
        {
            await _writer.FlushAsync().ConfigureAwait(false);
        }
    }

    public async Task SendFileAsync(string path, long offset, long? count, CancellationToken cancellationToken = default)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 65536, true);
        file.Position = offset;
        var remaining = count ?? file.Length - offset;
        var block = new byte[65536];
        while (remaining > 0)
        {
            var length = await file.ReadAsync(block.AsMemory(0, (int)Math.Min(block.Length, remaining)), cancellationToken).ConfigureAwait(false);
            if (length == 0) break;
            await Buffer.WriteAsync(block.AsMemory(0, length), cancellationToken).ConfigureAwait(false);
            remaining -= length;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_writer is not null) await _writer.CompleteAsync().ConfigureAwait(false);
        await Buffer.DisposeAsync().ConfigureAwait(false);
    }
}
