#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface IskraMarkdownTextManager : RCTViewManager
@end

@implementation IskraMarkdownTextManager

RCT_EXPORT_MODULE(IskraMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface IskraMarkdownTextRunManager : RCTViewManager
@end

@implementation IskraMarkdownTextRunManager

RCT_EXPORT_MODULE(IskraMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
