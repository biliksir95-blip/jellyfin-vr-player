using System.Reflection;
using System.Security.Cryptography;

namespace Jellyfin.Plugin.VrPlayer;

public sealed class VrPlayerAssets
{
    public VrPlayerAssets()
    {
        Player = Load("player.js");
        Three = Load("three.min.js");
        Version = Convert.ToHexString(SHA256.HashData(Player.Bytes.Concat(Three.Bytes).ToArray()))[..16].ToLowerInvariant();
    }

    public WebAsset Player { get; }

    public WebAsset Three { get; }

    public string Version { get; }

    private static WebAsset Load(string name)
    {
        using var resource = typeof(VrPlayerAssets).Assembly.GetManifestResourceStream($"Jellyfin.Plugin.VrPlayer.Assets.{name}")
            ?? throw new InvalidOperationException($"Missing embedded asset: {name}");
        using var memory = new MemoryStream();
        resource.CopyTo(memory);
        var bytes = memory.ToArray();
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        return new WebAsset(bytes, $"\"{hash}\"");
    }
}

public sealed record WebAsset(byte[] Bytes, string ETag);
