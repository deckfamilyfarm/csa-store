import React from "react";

export function ProductDetailSection({ productDetail }) {
  return (
    <section className="section" id="product-detail">
      <div className="container">
        <div className="grid two">
          <div className="product-gallery">
            <div className="product-photo">
              <img
                src={productDetail.gallery[0].image}
                alt={productDetail.gallery[0].alt}
                loading="lazy"
              />
            </div>
            <div className="grid two">
              {productDetail.gallery.slice(1).map((photo) => (
                <div key={photo.image} className="product-photo">
                  <img src={photo.image} alt={photo.alt} loading="lazy" />
                </div>
              ))}
            </div>
          </div>
          <div className="card pad">
            <div className="eyebrow">{productDetail.eyebrow}</div>
            <h2 className="h2">{productDetail.title}</h2>
            <p className="lede">{productDetail.body}</p>
            <div className="price">{productDetail.price}</div>
            <div className="small">{productDetail.note}</div>
            <div className="button-row">
              <a className="button" href="#">
                Add to cart
              </a>
              <a className="button alt" href="#">
                Save for recurring
              </a>
            </div>
            <div className="review-block">
              <strong>Reviews</strong>
              {productDetail.reviews.map((review) => (
                <div key={review.quote} className="review">
                  <div className="small">
                    {review.rating} "{review.quote}"
                  </div>
                  <div className="small">
                    - {review.author}, {review.date}
                  </div>
                </div>
              ))}
              <a className="button alt" href="#">
                Write a review
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
