#pragma once

#include <react/renderer/components/IskraMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/IskraMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char IskraMarkdownTextComponentName[];

struct IskraMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct IskraMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
  /// Recolor the loaded image with the run's foreground color, like `sf:` symbols.
  bool tintWithForeground;
  Float chipWidth = 0;
  Float chipHeight = 0;
};

inline Float IskraMarkdownTextAttachmentSize(const IskraMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float IskraMarkdownTextAttachmentBaselineOffset(
    const IskraMarkdownTextAttachmentRange &) {
  return -2;
}

class IskraMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<IskraMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<IskraMarkdownTextAttachmentRange> attachmentRanges;
};

class IskraMarkdownTextShadowNode final : public ConcreteViewShadowNode<
IskraMarkdownTextComponentName,
IskraMarkdownTextProps,
IskraMarkdownTextEventEmitter,
IskraMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  IskraMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<IskraMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<IskraMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
