#pragma once

#include "IskraMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using IskraMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<IskraMarkdownTextShadowNode>;

void IskraMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
