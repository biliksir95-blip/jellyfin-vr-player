using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.VrPlayer;

public sealed class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public const string PluginId = "e93f3537-69fa-4d5e-a354-620781d88cd1";

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Jellyfin VR Player";

    public override Guid Id => Guid.Parse(PluginId);

    public override string Description => "WebXR VR playback for Jellyfin Web with local JavaScript assets.";

    public IEnumerable<PluginPageInfo> GetPages() =>
    [
        new PluginPageInfo
        {
            Name = "JellyfinVrPlayer",
            EmbeddedResourcePath = "Jellyfin.Plugin.VrPlayer.Configuration.configPage.html"
        }
    ];
}

public sealed class PluginConfiguration : BasePluginConfiguration
{
    public bool Enabled { get; set; } = true;
}
