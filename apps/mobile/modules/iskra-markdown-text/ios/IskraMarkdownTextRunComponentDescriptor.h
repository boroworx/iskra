#pragma once

#include "IskraMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using IskraMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<IskraMarkdownTextRunShadowNode>;

void IskraMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
