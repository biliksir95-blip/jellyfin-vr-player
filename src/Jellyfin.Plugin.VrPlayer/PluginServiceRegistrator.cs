using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.VrPlayer;

public sealed class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<VrPlayerAssets>();
        serviceCollection.AddSingleton<IStartupFilter, VrPlayerStartupFilter>();
    }
}

public sealed class VrPlayerStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.UseMiddleware<VrPlayerMiddleware>((Func<bool>)(() => Plugin.Instance?.Configuration.Enabled ?? true));
        next(app);
    };
}
