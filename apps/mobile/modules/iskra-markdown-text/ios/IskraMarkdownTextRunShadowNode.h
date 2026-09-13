#pragma once

#include <react/renderer/components/IskraMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/IskraMarkdownTextSpec/Props.h>
#include <react/renderer/components/IskraMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char IskraMarkdownTextRunComponentName[];

using IskraMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    IskraMarkdownTextRunComponentName,
    IskraMarkdownTextRunProps,
    IskraMarkdownTextRunEventEmitter,
    IskraMarkdownTextRunState>;
}
